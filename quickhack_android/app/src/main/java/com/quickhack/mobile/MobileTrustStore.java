package com.quickhack.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class MobileTrustStore {
    private static final String PREFS = "quickhack.mobile.managed-trust.v1";
    private static final String ORIGIN = "origin";
    private static final String BUNDLE = "bundle";
    private static final String KEY_ALIAS = "quickhack_mobile_managed_trust_key_v1";
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String AAD_PREFIX = "QH-MOBILE-MANAGED-TRUST-V1\n";
    private static final int TAG_BITS = 128;

    private final SharedPreferences preferences;

    MobileTrustStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized void save(ManagedTrustBundle bundle) throws Exception {
        String origin = ServerOrigin.normalize(bundle.origin);
        String encrypted = encrypt(bundle.toJson().toString(), origin);
        if (!preferences.edit().putString(ORIGIN, origin).putString(BUNDLE, encrypted).commit()) {
            throw new GeneralSecurityException("Unable to durably save the managed trust bundle.");
        }
    }

    synchronized ManagedTrustBundle load(String expectedOrigin) throws Exception {
        String origin = preferences.getString(ORIGIN, "");
        String encrypted = preferences.getString(BUNDLE, "");
        if ((origin == null || origin.isEmpty()) && (encrypted == null || encrypted.isEmpty())) {
            return null;
        }
        if (origin == null || origin.isEmpty() || encrypted == null || encrypted.isEmpty()) {
            throw new GeneralSecurityException("Managed trust state is incomplete.");
        }
        String canonical = ServerOrigin.normalize(origin);
        if (expectedOrigin != null && !expectedOrigin.trim().isEmpty() &&
            !ServerOrigin.same(canonical, expectedOrigin)) {
            return null;
        }
        ManagedTrustBundle bundle = ManagedTrustBundle.parse(
            new JSONObject(decrypt(encrypted, canonical))
        );
        if (!ServerOrigin.same(canonical, bundle.origin)) {
            throw new GeneralSecurityException("Managed trust origin does not match its AAD.");
        }
        return bundle;
    }

    private String encrypt(String plaintext, String origin) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(aad(origin));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
            Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String envelope, String origin) throws GeneralSecurityException {
        String[] parts = envelope.split(":", 2);
        if (parts.length != 2) throw new GeneralSecurityException("Invalid managed trust envelope.");
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            new GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        cipher.updateAAD(aad(origin));
        return new String(
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        );
    }

    private byte[] aad(String origin) {
        return (AAD_PREFIX + ServerOrigin.normalize(origin)).getBytes(StandardCharsets.UTF_8);
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
            KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                PROVIDER
            );
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
            throw new GeneralSecurityException("Managed trust key is unavailable.");
        }
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }
}
