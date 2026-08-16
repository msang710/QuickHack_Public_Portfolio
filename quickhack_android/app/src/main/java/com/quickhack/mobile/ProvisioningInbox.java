package com.quickhack.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class ProvisioningInbox {
    private static final String PREFS = "quickhack.mobile.provisioning-inbox";
    private static final String PAYLOAD = "payload";
    private static final String KEY_ALIAS = "quickhack_mobile_provisioning_inbox_key_v1";
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String ENVELOPE_VERSION = "v1";
    private static final String AAD = "QH-MOBILE-PROVISIONING-INBOX-V1";
    private static final int TAG_BITS = 128;

    static synchronized void put(Context context, String payload)
        throws GeneralSecurityException {
        if (payload == null || payload.trim().isEmpty()) {
            throw new GeneralSecurityException("Provisioning payload is empty.");
        }
        writeEncrypted(preferences(context), payload);
    }

    static synchronized String peek(Context context) throws GeneralSecurityException {
        SharedPreferences preferences = preferences(context);
        String stored = preferences.getString(PAYLOAD, "");
        if (stored == null || stored.isEmpty()) return "";
        if (!stored.startsWith(ENVELOPE_VERSION + ":")) {
            // One-release compatibility for payloads written by the previous
            // MODE_PRIVATE plaintext inbox. The migration is durable before
            // the caller is allowed to proceed to activation.
            writeEncrypted(preferences, stored);
            return stored;
        }
        return decrypt(stored);
    }

    static synchronized boolean removeIfMatches(Context context, String expectedPayload)
        throws GeneralSecurityException {
        String current = peek(context);
        if (!current.equals(expectedPayload)) return false;
        if (!preferences(context).edit().remove(PAYLOAD).commit()) {
            throw new GeneralSecurityException("Unable to clear the provisioning inbox.");
        }
        deleteKey();
        return true;
    }

    static synchronized void clear(Context context) throws GeneralSecurityException {
        if (!preferences(context).edit().remove(PAYLOAD).commit()) {
            throw new GeneralSecurityException("Unable to clear the provisioning inbox.");
        }
        deleteKey();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void writeEncrypted(SharedPreferences preferences, String payload)
        throws GeneralSecurityException {
        if (!preferences.edit().putString(PAYLOAD, encrypt(payload)).commit()) {
            throw new GeneralSecurityException("Unable to durably save the provisioning inbox.");
        }
    }

    private static String encrypt(String payload) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(payload.getBytes(StandardCharsets.UTF_8));
        return ENVELOPE_VERSION
            + ":"
            + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + ":"
            + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private static String decrypt(String envelope) throws GeneralSecurityException {
        String[] parts = envelope.split(":", 3);
        if (parts.length != 3 || !ENVELOPE_VERSION.equals(parts[0])) {
            throw new GeneralSecurityException("Invalid provisioning inbox envelope.");
        }
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            new GCMParameterSpec(TAG_BITS, Base64.decode(parts[1], Base64.NO_WRAP))
        );
        cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
        return new String(
            cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        );
    }

    private static KeyStore keyStore() throws GeneralSecurityException {
        KeyStore store = KeyStore.getInstance(PROVIDER);
        try {
            store.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException(error);
        }
        return store;
    }

    private static SecretKey key() throws GeneralSecurityException {
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
            throw new GeneralSecurityException("Provisioning inbox key is unavailable.");
        }
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }

    private static void deleteKey() {
        try {
            keyStore().deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // The empty inbox remains fail-closed even if the obsolete key
            // cannot be removed immediately.
        }
    }

    private ProvisioningInbox() {}
}
