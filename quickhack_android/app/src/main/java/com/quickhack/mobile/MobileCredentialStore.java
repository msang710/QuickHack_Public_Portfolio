package com.quickhack.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class MobileCredentialStore {
    private static final String PREFS = "quickhack.mobile.v2";
    private static final String ORIGIN = "credentialOrigin";
    private static final String CLIENT_ID = "clientId";
    private static final String DEVICE_TOKEN = "deviceTokenCiphertext";
    private static final String PENDING_ACTIVATION_ORIGIN = "pendingActivationOrigin";
    private static final String PENDING_ACTIVATION = "pendingActivationCiphertext";
    private static final String SERVER_ORIGIN = "serverOrigin";
    private static final String KEY_ALIAS = "quickhack_mobile_device_token_key_v2";
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    private static final String PENDING_AAD = "QH-MOBILE-PENDING-ACTIVATION-V1\n";

    private final SharedPreferences preferences;
    private final MobileProofKey proofKey;

    MobileCredentialStore(Context context, MobileProofKey proofKey) {
        this.preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.proofKey = proofKey;
        context.getSharedPreferences("quickhack.mobile", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .apply();
    }

    String serverOrigin() {
        return preferences.getString(SERVER_ORIGIN, "");
    }

    void switchOrigin(String rawOrigin) {
        String origin = ServerOrigin.normalize(rawOrigin);
        String current = preferences.getString(ORIGIN, "");
        if (!current.isEmpty() && !ServerOrigin.same(current, origin)) {
            clearCredentialMaterial();
        }
        requireCommit(
            preferences.edit().putString(SERVER_ORIGIN, origin).commit(),
            "Unable to save the server origin."
        );
    }

    String clientId(String rawOrigin) {
        String origin = ServerOrigin.normalize(rawOrigin);
        String storedOrigin = preferences.getString(ORIGIN, "");
        String current = preferences.getString(CLIENT_ID, "");
        if (ServerOrigin.same(storedOrigin, origin) && current != null && !current.isEmpty()) {
            return current;
        }
        clearCredentialMaterial();
        String created = UUID.randomUUID().toString();
        requireCommit(
            preferences.edit().putString(ORIGIN, origin).putString(CLIENT_ID, created).commit(),
            "Unable to save the app instance ID."
        );
        return created;
    }

    String loadDeviceToken(String rawOrigin) {
        String origin = ServerOrigin.normalize(rawOrigin);
        if (!ServerOrigin.same(preferences.getString(ORIGIN, ""), origin)) return "";
        String encrypted = preferences.getString(DEVICE_TOKEN, "");
        if (encrypted == null || encrypted.isEmpty()) return "";
        try {
            return decrypt(encrypted, origin);
        } catch (Exception error) {
            if (hasPendingActivation()) {
                requireCommit(
                    preferences.edit().remove(DEVICE_TOKEN).commit(),
                    "Unable to clear an invalid device token."
                );
            } else {
                clearCredentialMaterial();
            }
            return "";
        }
    }

    void saveDeviceToken(String rawOrigin, String clientId, String token)
        throws GeneralSecurityException {
        String origin = ServerOrigin.normalize(rawOrigin);
        boolean committed = preferences.edit()
            .putString(ORIGIN, origin)
            .putString(SERVER_ORIGIN, origin)
            .putString(CLIENT_ID, clientId)
            .putString(DEVICE_TOKEN, encrypt(token, origin))
            .commit();
        if (!committed) {
            throw new GeneralSecurityException("Unable to durably save the device credential.");
        }
    }

    PendingActivationRecord loadPendingActivation()
        throws GeneralSecurityException, JSONException {
        String origin = preferences.getString(PENDING_ACTIVATION_ORIGIN, "");
        String encrypted = preferences.getString(PENDING_ACTIVATION, "");
        if ((origin == null || origin.isEmpty()) && (encrypted == null || encrypted.isEmpty())) {
            return null;
        }
        if (origin == null || origin.isEmpty() || encrypted == null || encrypted.isEmpty()) {
            throw new GeneralSecurityException("Pending activation state is incomplete.");
        }
        String plaintext = decrypt(encrypted, pendingAad(origin));
        PendingActivationRecord record = PendingActivationRecord.parse(new JSONObject(plaintext));
        if (!ServerOrigin.same(origin, record.serverOrigin)) {
            throw new GeneralSecurityException("Pending activation origin does not match its AAD.");
        }
        return record;
    }

    void savePendingActivation(PendingActivationRecord record)
        throws GeneralSecurityException, JSONException {
        String encrypted = encrypt(record.toJson().toString(), pendingAad(record.serverOrigin));
        boolean committed = preferences.edit()
            .putString(ORIGIN, record.serverOrigin)
            .putString(SERVER_ORIGIN, record.serverOrigin)
            .putString(CLIENT_ID, record.appInstanceId)
            .putString(PENDING_ACTIVATION_ORIGIN, record.serverOrigin)
            .putString(PENDING_ACTIVATION, encrypted)
            .commit();
        if (!committed) {
            throw new GeneralSecurityException("Unable to durably save pending activation state.");
        }
    }

    boolean clearPendingActivation(PendingActivationRecord expected)
        throws GeneralSecurityException, JSONException {
        PendingActivationRecord current = loadPendingActivation();
        if (current == null) return true;
        if (!current.operationId.equals(expected.operationId)) return false;
        return preferences.edit()
            .remove(PENDING_ACTIVATION_ORIGIN)
            .remove(PENDING_ACTIVATION)
            .commit();
    }

    boolean hasPendingActivation() {
        return preferences.contains(PENDING_ACTIVATION_ORIGIN)
            || preferences.contains(PENDING_ACTIVATION);
    }

    void clearCredentialMaterial() {
        requireCommit(
            preferences.edit()
                .remove(ORIGIN)
                .remove(CLIENT_ID)
                .remove(DEVICE_TOKEN)
                .remove(PENDING_ACTIVATION_ORIGIN)
                .remove(PENDING_ACTIVATION)
                .commit(),
            "Unable to clear credential material."
        );
        proofKey.delete();
        try {
            keyStore().deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // Missing/invalid keys are already unusable.
        }
    }

    private KeyStore keyStore() throws GeneralSecurityException {
        KeyStore store = KeyStore.getInstance(PROVIDER);
        try {
            store.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException(error);
        }
        return store;
    }

    private SecretKey key() throws GeneralSecurityException {
        KeyStore store = keyStore();
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
            generator.init(
                new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            generator.generateKey();
        }
        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (!(entry instanceof KeyStore.SecretKeyEntry)) {
            throw new GeneralSecurityException("Device token key is unavailable.");
        }
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }

    private String pendingAad(String origin) {
        return PENDING_AAD + ServerOrigin.normalize(origin);
    }

    private String encrypt(String token, String aad) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + ":"
            + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String encrypted, String aad) throws GeneralSecurityException {
        String[] parts = encrypted.split(":", 2);
        if (parts.length != 2) throw new GeneralSecurityException("Invalid encrypted token.");
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            new GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        return new String(
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        );
    }

    private void requireCommit(boolean committed, String message) {
        if (!committed) throw new IllegalStateException(message);
    }
}
