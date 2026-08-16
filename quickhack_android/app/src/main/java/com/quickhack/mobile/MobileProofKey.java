package com.quickhack.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

final class MobileProofKey {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String ALIAS = "quickhack_mobile_proof_key_v2";

    private KeyStore keyStore() throws GeneralSecurityException {
        KeyStore store = KeyStore.getInstance(PROVIDER);
        try {
            store.load(null);
        } catch (Exception error) {
            throw new GeneralSecurityException(error);
        }
        return store;
    }

    void ensureCreated() throws GeneralSecurityException {
        KeyStore store = keyStore();
        if (store.containsAlias(ALIAS)) return;
        KeyPairGenerator generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            PROVIDER
        );
        generator.initialize(
            new KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        );
        generator.generateKeyPair();
    }

    String publicKeySpkiBase64() throws GeneralSecurityException {
        ensureCreated();
        return Base64.encodeToString(
            keyStore().getCertificate(ALIAS).getPublicKey().getEncoded(),
            Base64.NO_WRAP
        );
    }

    String signBase64(String message) throws GeneralSecurityException {
        ensureCreated();
        PrivateKey privateKey = (PrivateKey) keyStore().getKey(ALIAS, null);
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(privateKey);
        signature.update(message.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }

    void delete() {
        try {
            keyStore().deleteEntry(ALIAS);
        } catch (Exception ignored) {
            // Clearing preferences still fail-closes the credential.
        }
    }
}
