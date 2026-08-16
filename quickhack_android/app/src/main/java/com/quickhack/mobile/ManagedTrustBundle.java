package com.quickhack.mobile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

final class ManagedTrustBundle {
    private static final int VERSION = 1;
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final int MAX_PEM_LENGTH = 16 * 1024;
    private static final Set<String> BASE_KEYS = setOf(
        "version",
        "origin",
        "currentCaSha256",
        "generatedAt",
        "currentCaPem",
        "identityDigestSha256"
    );
    private static final Set<String> ROTATION_KEYS = setOf(
        "version",
        "origin",
        "currentCaSha256",
        "previousCaSha256",
        "rotationNotBefore",
        "generatedAt",
        "currentCaPem",
        "previousCaPem",
        "identityDigestSha256"
    );

    final String origin;
    final String currentCaSha256;
    final String previousCaSha256;
    final String rotationNotBefore;
    final String generatedAt;
    final String currentCaPem;
    final String previousCaPem;
    final String identityDigestSha256;
    private final X509Certificate currentCertificate;
    private final X509Certificate previousCertificate;
    private SSLSocketFactory socketFactory;

    private ManagedTrustBundle(
        String origin,
        String currentCaSha256,
        String previousCaSha256,
        String rotationNotBefore,
        String generatedAt,
        String currentCaPem,
        String previousCaPem,
        String identityDigestSha256,
        X509Certificate currentCertificate,
        X509Certificate previousCertificate
    ) {
        this.origin = origin;
        this.currentCaSha256 = currentCaSha256;
        this.previousCaSha256 = previousCaSha256;
        this.rotationNotBefore = rotationNotBefore;
        this.generatedAt = generatedAt;
        this.currentCaPem = currentCaPem;
        this.previousCaPem = previousCaPem;
        this.identityDigestSha256 = identityDigestSha256;
        this.currentCertificate = currentCertificate;
        this.previousCertificate = previousCertificate;
    }

    static ManagedTrustBundle parse(JSONObject json) throws Exception {
        if (json == null || json.optInt("version", 0) != VERSION) {
            throw new IllegalArgumentException("Unsupported managed trust bundle version.");
        }
        boolean rotated = json.has("previousCaSha256") ||
            json.has("rotationNotBefore") ||
            json.has("previousCaPem");
        requireExactKeys(json, rotated ? ROTATION_KEYS : BASE_KEYS);
        String origin = ServerOrigin.normalize(json.getString("origin"));
        if (!origin.startsWith("https://") || !origin.equals(json.getString("origin"))) {
            throw new IllegalArgumentException("Managed trust bundle origin must be canonical HTTPS.");
        }
        String currentFingerprint = requireSha256(
            json.getString("currentCaSha256"),
            "currentCaSha256"
        );
        String generatedAt = requireTimestamp(json.getString("generatedAt"), "generatedAt");
        long generatedTime = parseTimestamp(generatedAt).getTime();
        if (generatedTime > System.currentTimeMillis() + 300_000L) {
            throw new IllegalArgumentException("Managed trust bundle was generated in the future.");
        }
        String currentPem = requirePem(json.getString("currentCaPem"), "currentCaPem");
        X509Certificate current = parseSingleCa(currentPem, "current CA");
        if (!currentFingerprint.equals(fingerprint(current))) {
            throw new IllegalArgumentException("Managed current CA fingerprint does not match.");
        }

        String previousFingerprint = "";
        String rotationNotBefore = "";
        String previousPem = "";
        X509Certificate previous = null;
        if (rotated) {
            previousFingerprint = requireSha256(
                json.getString("previousCaSha256"),
                "previousCaSha256"
            );
            rotationNotBefore = requireTimestamp(
                json.getString("rotationNotBefore"),
                "rotationNotBefore"
            );
            if (parseTimestamp(rotationNotBefore).after(parseTimestamp(generatedAt))) {
                throw new IllegalArgumentException("rotationNotBefore cannot be after generatedAt.");
            }
            previousPem = requirePem(json.getString("previousCaPem"), "previousCaPem");
            previous = parseSingleCa(previousPem, "previous CA");
            if (!previousFingerprint.equals(fingerprint(previous))) {
                throw new IllegalArgumentException("Managed previous CA fingerprint does not match.");
            }
            if (previousFingerprint.equals(currentFingerprint)) {
                throw new IllegalArgumentException("Managed current and previous CA must differ.");
            }
        }
        String identityDigest = requireSha256(
            json.getString("identityDigestSha256"),
            "identityDigestSha256"
        );
        String expectedDigest = identityDigest(
            origin,
            currentFingerprint,
            previousFingerprint,
            rotationNotBefore,
            generatedAt
        );
        if (!identityDigest.equals(expectedDigest)) {
            throw new IllegalArgumentException("Managed trust bundle identity digest does not match.");
        }
        return new ManagedTrustBundle(
            origin,
            currentFingerprint,
            previousFingerprint,
            rotationNotBefore,
            generatedAt,
            currentPem,
            previousPem,
            identityDigest,
            current,
            previous
        );
    }

    JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("version", VERSION);
        json.put("origin", origin);
        json.put("currentCaSha256", currentCaSha256);
        if (!previousCaSha256.isEmpty()) {
            json.put("previousCaSha256", previousCaSha256);
            json.put("rotationNotBefore", rotationNotBefore);
        }
        json.put("generatedAt", generatedAt);
        json.put("currentCaPem", currentCaPem);
        if (!previousCaPem.isEmpty()) json.put("previousCaPem", previousCaPem);
        json.put("identityDigestSha256", identityDigestSha256);
        return json;
    }

    synchronized SSLSocketFactory socketFactory() throws Exception {
        if (socketFactory != null) return socketFactory;
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null);
        store.setCertificateEntry("quickhack-current", currentCertificate);
        if (previousCertificate != null) {
            store.setCertificateEntry("quickhack-previous", previousCertificate);
        }
        TrustManagerFactory managers = TrustManagerFactory.getInstance(
            TrustManagerFactory.getDefaultAlgorithm()
        );
        managers.init(store);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, managers.getTrustManagers(), null);
        socketFactory = context.getSocketFactory();
        return socketFactory;
    }

    private static X509Certificate parseSingleCa(String pem, String label) throws Exception {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        List<Certificate> certificates = new ArrayList<>(factory.generateCertificates(
            new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII))
        ));
        if (certificates.size() != 1 || !(certificates.get(0) instanceof X509Certificate)) {
            throw new IllegalArgumentException(label + " must contain exactly one certificate.");
        }
        X509Certificate certificate = (X509Certificate) certificates.get(0);
        certificate.checkValidity(new Date());
        if (certificate.getBasicConstraints() < 0) {
            throw new IllegalArgumentException(label + " is not a CA certificate.");
        }
        return certificate;
    }

    private static String requirePem(String value, String label) {
        String normalized = value == null
            ? ""
            : value.replace("\r\n", "\n").replace('\r', '\n').trim() + "\n";
        if (
            normalized.length() > MAX_PEM_LENGTH ||
            !normalized.startsWith("-----BEGIN CERTIFICATE-----\n") ||
            !normalized.endsWith("-----END CERTIFICATE-----\n")
        ) {
            throw new IllegalArgumentException(label + " is invalid.");
        }
        return normalized;
    }

    private static String fingerprint(X509Certificate certificate) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
    }

    private static String identityDigest(
        String origin,
        String current,
        String previous,
        String rotation,
        String generated
    ) throws Exception {
        String value = VERSION + "\n" + origin + "\n" + current + "\n" +
            previous + "\n" + rotation + "\n" + generated;
        return hex(MessageDigest.getInstance("SHA-256").digest(
            value.getBytes(StandardCharsets.UTF_8)
        ));
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.US, "%02x", value & 0xff));
        return result.toString();
    }

    private static String requireSha256(String value, String label) {
        String normalized = value == null ? "" : value.trim();
        if (!SHA256.matcher(normalized).matches()) {
            throw new IllegalArgumentException(label + " is invalid.");
        }
        return normalized;
    }

    private static String requireTimestamp(String value, String label) {
        String normalized = value == null ? "" : value.trim();
        try {
            parseTimestamp(normalized);
        } catch (ParseException error) {
            throw new IllegalArgumentException(label + " is invalid.", error);
        }
        return normalized;
    }

    private static Date parseTimestamp(String value) throws ParseException {
        SimpleDateFormat format = new SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            Locale.US
        );
        format.setLenient(false);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date parsed = format.parse(value);
        if (parsed == null || !format.format(parsed).equals(value)) {
            throw new ParseException("Timestamp is not canonical UTC.", 0);
        }
        return parsed;
    }

    private static void requireExactKeys(JSONObject json, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) actual.add(keys.next());
        if (!actual.equals(expected)) {
            throw new IllegalArgumentException("Managed trust bundle has unknown or missing fields.");
        }
    }

    private static Set<String> setOf(String... values) {
        Set<String> result = new HashSet<>();
        for (String value : values) result.add(value);
        return result;
    }
}
