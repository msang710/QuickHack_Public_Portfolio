package com.quickhack.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ServerOriginTest {
    @Test
    public void normalizesEffectivePorts() {
        assertEquals("https://quickhack.example", ServerOrigin.normalize("https://QuickHack.Example:443/"));
        assertEquals("http://10.0.0.5:3000", ServerOrigin.normalize("http://10.0.0.5:3000"));
        assertTrue(ServerOrigin.same("https://quickhack.example", "https://QUICKHACK.example:443/"));
        assertFalse(ServerOrigin.same("https://quickhack.example", "https://quickhack.example:444"));
    }

    @Test
    public void rejectsNonOriginUrls() {
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerOrigin.normalize("https://quickhack.example/api")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> ServerOrigin.normalize("https://user@quickhack.example")
        );
    }

    @Test
    public void quickHackResponseRequiresExplicitJsonSuccess() {
        assertFalse(new QuickHackApi.ApiResponse(200, "", true).isQuickHackOk());
        assertFalse(new QuickHackApi.ApiResponse(200, "{}", true).isQuickHackOk());
        assertFalse(new QuickHackApi.ApiResponse(200, "{\"ok\":\"true\"}", true).isQuickHackOk());
        assertFalse(new QuickHackApi.ApiResponse(302, "{\"ok\":true}", false).isQuickHackOk());
        assertTrue(new QuickHackApi.ApiResponse(200, "{\"ok\":true}", true).isQuickHackOk());
    }
}
