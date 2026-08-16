package com.quickhack.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

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
    private static final String SERVER_ORIGIN = "serverOrigin";
    private static final String KEY_ALIAS = "quickhack_mobile_device_token_key_v2";
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;

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
        preferences.edit().putString(SERVER_ORIGIN, origin).apply();
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
        preferences.edit().putString(ORIGIN, origin).putString(CLIENT_ID, created).apply();
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
            clearCredentialMaterial();
            return "";
        }
    }

    void saveDeviceToken(String rawOrigin, String clientId, String token)
        throws GeneralSecurityException {
        String origin = ServerOrigin.normalize(rawOrigin);
        preferences.edit()
            .putString(ORIGIN, origin)
            .putString(SERVER_ORIGIN, origin)
            .putString(CLIENT_ID, clientId)
            .putString(DEVICE_TOKEN, encrypt(token, origin))
            .apply();
    }

    void clearCredentialMaterial() {
        preferences.edit().remove(ORIGIN).remove(CLIENT_ID).remove(DEVICE_TOKEN).apply();
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

    private String encrypt(String token, String origin) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + ":"
            + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String encrypted, String origin) throws GeneralSecurityException {
        String[] parts = encrypted.split(":", 2);
        if (parts.length != 2) throw new GeneralSecurityException("Invalid encrypted token.");
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            new GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
        return new String(
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        );
    }
}
