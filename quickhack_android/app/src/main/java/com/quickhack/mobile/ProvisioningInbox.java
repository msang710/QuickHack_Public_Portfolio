package com.quickhack.mobile;

import android.content.Context;

final class ProvisioningInbox {
    private static final String PREFS = "quickhack.mobile.provisioning-inbox";
    private static final String PAYLOAD = "payload";

    static synchronized void put(Context context, String payload) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(PAYLOAD, payload)
            .commit();
    }

    static synchronized String take(Context context) {
        String payload = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(PAYLOAD, "");
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(PAYLOAD)
            .commit();
        return payload == null ? "" : payload;
    }

    private ProvisioningInbox() {}
}
