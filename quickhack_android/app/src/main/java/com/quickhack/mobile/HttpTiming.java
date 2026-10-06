package com.quickhack.mobile;

final class HttpTiming {
    private final long startedNs;
    private long headerNs = -1L;

    HttpTiming(long startedNs) {
        this.startedNs = startedNs;
    }

    void headersAt(long nowNs) {
        if (headerNs < 0L) headerNs = Math.max(startedNs, nowNs);
    }

    Snapshot completeAt(long nowNs, String traceId, boolean timedOut) {
        long finishedNs = Math.max(startedNs, nowNs);
        return new Snapshot(
            headerNs < 0L ? -1L : (headerNs - startedNs) / 1_000_000L,
            (finishedNs - startedNs) / 1_000_000L,
            traceId != null && traceId.matches("[A-Za-z0-9-]{1,64}") ? traceId : "",
            timedOut
        );
    }

    static final class Snapshot {
        final long headerMs;
        final long totalMs;
        final String traceId;
        final boolean timedOut;

        Snapshot(long headerMs, long totalMs, String traceId, boolean timedOut) {
            this.headerMs = headerMs;
            this.totalMs = totalMs;
            this.traceId = traceId;
            this.timedOut = timedOut;
        }

        String toLogLine() {
            return "headerMs=" + headerMs + " totalMs=" + totalMs
                + " timeout=" + timedOut + " traceId=" + traceId;
        }
    }
}
