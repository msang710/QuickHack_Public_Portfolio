package com.quickhack.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public final class AdbProvisioningActivity extends Activity {
    static final String PROVISION_EXTRA = "quickhack_provisioning_payload";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String payload = getIntent().getStringExtra(PROVISION_EXTRA);
        if (payload != null && !payload.trim().isEmpty()) {
            ProvisioningInbox.put(this, payload);
            Intent main = new Intent(this, MainActivity.class);
            main.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
            );
            startActivity(main);
        }
        finish();
    }
}
