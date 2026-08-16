package com.quickhack.mobile;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Locale;

final class ServerOrigin {
    private final String value;

    private ServerOrigin(String value) {
        this.value = value;
    }

    static ServerOrigin parse(String raw) throws MalformedURLException {
        URL url = new URL(raw == null ? "" : raw.trim());
        String scheme = url.getProtocol().toLowerCase(Locale.US);
        String host = url.getHost().toLowerCase(Locale.US);
        if (!("http".equals(scheme) || "https".equals(scheme)) || host.isEmpty()) {
            throw new MalformedURLException("QuickHack server origin is invalid.");
        }
        if (url.getUserInfo() != null && !url.getUserInfo().isEmpty()) {
            throw new MalformedURLException("QuickHack server origin must not contain user information.");
        }
        String path = url.getPath();
        if ((path != null && !path.isEmpty() && !"/".equals(path))
            || url.getQuery() != null
            || url.getRef() != null) {
            throw new MalformedURLException("QuickHack server URL must be an origin.");
        }
        int port = url.getPort();
        int effectivePort = port >= 0 ? port : ("https".equals(scheme) ? 443 : 80);
        String hostText = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        boolean defaultPort = ("https".equals(scheme) && effectivePort == 443)
            || ("http".equals(scheme) && effectivePort == 80);
        return new ServerOrigin(scheme + "://" + hostText + (defaultPort ? "" : ":" + effectivePort));
    }

    static String normalize(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "";
        try {
            return parse(raw).value;
        } catch (MalformedURLException error) {
            throw new IllegalArgumentException(error.getMessage(), error);
        }
    }

    static boolean same(String left, String right) {
        try {
            return parse(left).value.equals(parse(right).value);
        } catch (MalformedURLException error) {
            return false;
        }
    }

    @Override
    public String toString() {
        return value;
    }
}
