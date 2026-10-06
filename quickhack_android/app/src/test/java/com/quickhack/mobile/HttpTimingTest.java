package com.quickhack.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HttpTimingTest {
    @Test
    public void measuresHeadersAndBodyUsingMonotonicTicks() {
        HttpTiming timing = new HttpTiming(1_000_000L);
        timing.headersAt(4_000_000L);
        HttpTiming.Snapshot snapshot = timing.completeAt(9_000_000L, "trace-1", false);
        assertEquals(3L, snapshot.headerMs);
        assertEquals(8L, snapshot.totalMs);
        assertEquals("trace-1", snapshot.traceId);
        assertFalse(snapshot.timedOut);
    }

    @Test
    public void timeoutWithoutHeadersIsReportedWithoutInventingHeaderTime() {
        HttpTiming timing = new HttpTiming(1_000_000L);
        HttpTiming.Snapshot snapshot = timing.completeAt(7_000_000L, null, true);
        assertEquals(-1L, snapshot.headerMs);
        assertEquals(6L, snapshot.totalMs);
        assertTrue(snapshot.timedOut);
    }
}
