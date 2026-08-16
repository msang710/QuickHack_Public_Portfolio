package com.quickhack.mobile;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

public final class ManagedTrustBundleTest {
    @Test
    public void acceptsCurrentOnlyAndCurrentPreviousBundles() throws Exception {
        ManagedTrustBundle current = ManagedTrustBundle.parse(bundle(false, false));
        assertEquals("https://quickhack.example:3443", current.origin);
        assertEquals("", current.previousCaSha256);
        assertNotNull(current.socketFactory());

        ManagedTrustBundle rotated = ManagedTrustBundle.parse(bundle(true, false));
        assertEquals(fingerprint(readCa("managed-ca-one.pem")), rotated.currentCaSha256);
        assertEquals(fingerprint(readCa("managed-ca-two.pem")), rotated.previousCaSha256);
        assertNotNull(rotated.socketFactory());
    }

    @Test
    public void rejectsWrongOriginFingerprintUnknownFieldsAndDuplicateRoots() throws Exception {
        JSONObject wrongOrigin = bundle(false, false);
        wrongOrigin.put("origin", "http://quickhack.example:3443");
        wrongOrigin.put("identityDigestSha256", identityDigest(wrongOrigin));
        assertThrows(IllegalArgumentException.class, () -> ManagedTrustBundle.parse(wrongOrigin));

        JSONObject wrongFingerprint = bundle(false, false);
        wrongFingerprint.put("currentCaSha256", repeat("0", 64));
        wrongFingerprint.put("identityDigestSha256", identityDigest(wrongFingerprint));
        assertThrows(IllegalArgumentException.class, () -> ManagedTrustBundle.parse(wrongFingerprint));

        JSONObject unknown = bundle(false, false);
        unknown.put("extra", true);
        assertThrows(IllegalArgumentException.class, () -> ManagedTrustBundle.parse(unknown));

        JSONObject duplicate = bundle(true, true);
        assertThrows(IllegalArgumentException.class, () -> ManagedTrustBundle.parse(duplicate));
    }

    private static JSONObject bundle(boolean rotated, boolean duplicate) throws Exception {
        String currentPem = resource("managed-ca-one.pem");
        String previousPem = resource(duplicate ? "managed-ca-one.pem" : "managed-ca-two.pem");
        String generatedAt = timestamp(System.currentTimeMillis() - 60_000L);
        JSONObject json = new JSONObject();
        json.put("version", 1);
        json.put("origin", "https://quickhack.example:3443");
        json.put("currentCaSha256", fingerprint(readCa("managed-ca-one.pem")));
        if (rotated) {
            json.put(
                "previousCaSha256",
                fingerprint(readCa(duplicate ? "managed-ca-one.pem" : "managed-ca-two.pem"))
            );
            json.put("rotationNotBefore", generatedAt);
        }
        json.put("generatedAt", generatedAt);
        json.put("currentCaPem", currentPem);
        if (rotated) json.put("previousCaPem", previousPem);
        json.put("identityDigestSha256", identityDigest(json));
        return json;
    }

    private static String identityDigest(JSONObject json) throws Exception {
        String value = "1\n" + json.getString("origin") + "\n" +
            json.getString("currentCaSha256") + "\n" +
            json.optString("previousCaSha256", "") + "\n" +
            json.optString("rotationNotBefore", "") + "\n" +
            json.getString("generatedAt");
        return hex(MessageDigest.getInstance("SHA-256").digest(
            value.getBytes(StandardCharsets.UTF_8)
        ));
    }

    private static X509Certificate readCa(String name) throws Exception {
        return (X509Certificate) CertificateFactory.getInstance("X.509")
            .generateCertificate(new java.io.ByteArrayInputStream(
                resource(name).getBytes(StandardCharsets.US_ASCII)
            ));
    }

    private static String resource(String name) throws Exception {
        InputStream stream = ManagedTrustBundleTest.class.getClassLoader().getResourceAsStream(name);
        if (stream == null) throw new IllegalStateException("Missing test resource: " + name);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = stream.read(buffer)) >= 0) output.write(buffer, 0, read);
        stream.close();
        return new String(output.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static String fingerprint(X509Certificate certificate) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(Locale.US, "%02x", value & 0xff));
        return result.toString();
    }

    private static String timestamp(long value) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(value));
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }
}
