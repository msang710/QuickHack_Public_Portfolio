package com.quickhack.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

final class QuickHackApi {
    private String baseUrl;
    private String cookieHeader = "";
    private ManagedTrustBundle trustBundle;

    QuickHackApi(String baseUrl) {
        this(baseUrl, null);
    }

    QuickHackApi(String baseUrl, ManagedTrustBundle trustBundle) {
        this.baseUrl = baseUrl == null || baseUrl.trim().isEmpty()
            ? ""
            : ServerOrigin.normalize(baseUrl);
        setManagedTrustBundle(trustBundle);
    }

    boolean setBaseUrl(String value) {
        String next = ServerOrigin.normalize(value);
        boolean changed = !baseUrl.isEmpty() && !ServerOrigin.same(baseUrl, next);
        if (changed || (trustBundle != null && !ServerOrigin.same(trustBundle.origin, next))) {
            cookieHeader = "";
            trustBundle = null;
        }
        baseUrl = next;
        return changed;
    }

    void setManagedTrustBundle(ManagedTrustBundle value) {
        if (value != null && !baseUrl.isEmpty() && !ServerOrigin.same(baseUrl, value.origin)) {
            throw new IllegalArgumentException("Managed trust bundle origin does not match the API origin.");
        }
        if (
            trustBundle != null &&
            value != null &&
            !trustBundle.identityDigestSha256.equals(value.identityDigestSha256)
        ) {
            cookieHeader = "";
        }
        trustBundle = value;
    }

    String getBaseUrl() {
        return baseUrl;
    }

    void clearSession() {
        cookieHeader = "";
    }

    ApiResponse login(String username, String password) throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        return postJson("/api/auth/login", body);
    }

    ApiResponse activateDevice(JSONObject body) throws IOException {
        return postJson("/api/mobile/activate-device", body);
    }

    ApiResponse packingCheck(List<String> scannedValues, String clientId, String deviceToken)
        throws IOException, JSONException {
        JSONObject body = new JSONObject();
        JSONArray values = new JSONArray();
        for (String value : scannedValues) values.put(value);
        body.put("scannedValues", values);
        body.put("appInstanceId", clientId);
        body.put("deviceToken", deviceToken);
        return postJson("/api/mobile/packing-check", body);
    }

    private ApiResponse postJson(String path, JSONObject body) throws IOException {
        HttpURLConnection connection = open(path, "POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        return execute(connection, body.toString());
    }

    private HttpURLConnection open(String path, String method) throws IOException {
        if (baseUrl.isEmpty()) throw new IOException("QuickHack server origin is not configured.");
        URL target = new URL(baseUrl + path);
        HttpURLConnection connection = (HttpURLConnection) target.openConnection();
        if (connection instanceof HttpsURLConnection) {
            if (trustBundle == null || !ServerOrigin.same(baseUrl, trustBundle.origin)) {
                throw new IOException("Authenticated QuickHack managed trust is required for this origin.");
            }
            try {
                ((HttpsURLConnection) connection).setSSLSocketFactory(
                    trustBundle.socketFactory()
                );
            } catch (Exception error) {
                throw new IOException("QuickHack managed TLS could not be initialized.", error);
            }
        } else if (!BuildConfig.DEBUG) {
            throw new IOException("Release builds require HTTPS managed trust.");
        }
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept", "application/json");
        if (!cookieHeader.isEmpty()) connection.setRequestProperty("Cookie", cookieHeader);
        return connection;
    }

    private ApiResponse execute(HttpURLConnection connection, String requestBody) throws IOException {
        try {
            if (requestBody != null) {
                BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8)
                );
                writer.write(requestBody);
                writer.close();
            }
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) {
                return new ApiResponse(code, "", false);
            }
            storeCookies(connection.getHeaderFields());
            InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new ApiResponse(code, stream == null ? "" : readStream(stream), true);
        } finally {
            connection.disconnect();
        }
    }

    private void storeCookies(Map<String, List<String>> headers) {
        List<String> cookies = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !"set-cookie".equals(entry.getKey().toLowerCase(Locale.US))) continue;
            for (String value : entry.getValue()) {
                if (value != null && !value.trim().isEmpty()) cookies.add(value.split(";", 2)[0].trim());
            }
        }
        if (!cookies.isEmpty()) cookieHeader = joinCookies(cookies);
    }

    private String joinCookies(List<String> cookies) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < cookies.size(); index += 1) {
            if (index > 0) builder.append("; ");
            builder.append(cookies.get(index));
        }
        return builder.toString();
    }

    private String readStream(InputStream stream) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        StringBuilder builder = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) builder.append(line);
        reader.close();
        return builder.toString();
    }

    static final class ApiResponse {
        final int code;
        final String body;
        final JSONObject json;
        final boolean directResponse;

        ApiResponse(int code, String body, boolean directResponse) {
            this.code = code;
            this.body = body == null ? "" : body;
            this.directResponse = directResponse;
            JSONObject parsed = null;
            try {
                if (!this.body.isEmpty()) parsed = new JSONObject(this.body);
            } catch (JSONException ignored) {
                parsed = null;
            }
            this.json = parsed;
        }

        boolean isHttpOk() {
            return directResponse && code >= 200 && code < 300;
        }

        boolean isQuickHackOk() {
            if (!isHttpOk() || json == null || !json.has("ok")) return false;
            Object value = json.opt("ok");
            return value instanceof Boolean && Boolean.TRUE.equals(value);
        }

        String errorCode() {
            return json == null ? "" : json.optString("code", "");
        }

        String messageOrDefault(String fallback) {
            String message = json == null ? "" : json.optString("message", "");
            return message.isEmpty() ? fallback : message;
        }
    }
}
