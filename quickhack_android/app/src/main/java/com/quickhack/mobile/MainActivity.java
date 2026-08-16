package com.quickhack.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.CircularProgressIndicator;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

public final class MainActivity extends AppCompatActivity {
    private static final String DEFAULT_SERVER_URL = "";
    private static final int CAMERA_PERMISSION_REQUEST = 2401;
    private static final Pattern PG_PATTERN = Pattern.compile("^[A-Z]{2}\\d{10}$");
    private static final Pattern IMEI_PATTERN = Pattern.compile("^\\d{15}$");

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ArrayList<String> scannedValues = new ArrayList<>();

    private final MobileProofKey proofKey = new MobileProofKey();
    private MobileCredentialStore credentialStore;
    private MobileTrustStore trustStore;
    private ManagedTrustBundle managedTrustBundle;
    private QuickHackApi api;
    private BarcodeCameraController cameraController;
    private String clientId;
    private String deviceToken;
    private ProvisioningRequest provisioningRequest;
    private PendingActivationRecord pendingActivation;
    private boolean pendingRecoveryBlocked;
    private boolean signalMode;
    private boolean busy;
    private CameraTarget pendingCameraTarget = CameraTarget.NONE;
    private Runnable pendingReset;

    private FrameLayout appRoot;
    private LinearLayout setupPanel;
    private LinearLayout signalPanel;
    private TextInputLayout serverUrlLayout;
    private TextInputEditText serverUrlInput;
    private TextInputEditText usernameInput;
    private TextInputEditText passwordInput;
    private TextView setupStatusText;
    private TextView signalStatusText;
    private TextView deviceValueText;
    private TextView shipmentValueText;
    private TextView allValuesText;
    private MaterialButton loginButton;
    private MaterialButton cancelActivationButton;
    private CircularProgressIndicator setupProgress;
    private PreviewView signalCameraPreview;
    private View cameraResultCover;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        credentialStore = new MobileCredentialStore(this, proofKey);
        trustStore = new MobileTrustStore(this);
        String storedOrigin = credentialStore.serverOrigin();
        try {
            managedTrustBundle = storedOrigin.isEmpty()
                ? null
                : trustStore.load(storedOrigin);
        } catch (Exception ignored) {
            managedTrustBundle = null;
        }
        api = new QuickHackApi(storedOrigin, managedTrustBundle);
        clientId = storedOrigin.isEmpty() ? "" : credentialStore.clientId(storedOrigin);
        deviceToken = storedOrigin.isEmpty() ? "" : credentialStore.loadDeviceToken(storedOrigin);

        setContentView(R.layout.activity_main);
        bindViews();
        applyWindowInsets();
        cameraController = new BarcodeCameraController(this, this);
        configureInputsAndActions();

        String initialMessage = deviceToken.isEmpty()
            ? getString(R.string.setup_initial_activation)
            : getString(R.string.setup_initial_login);
        showSetup(initialMessage);
        handleProvisioningInbox();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleProvisioningInbox();
    }

    @Override
    protected void onDestroy() {
        if (pendingReset != null) {
            mainHandler.removeCallbacks(pendingReset);
        }
        if (cameraController != null) {
            cameraController.close();
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (signalMode) {
            showSetup(getString(R.string.setup_mode));
            return;
        }
        super.onBackPressed();
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        @NonNull String[] permissions,
        @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST) {
            return;
        }
        if (grantResults.length > 0
            && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            CameraTarget target = pendingCameraTarget;
            pendingCameraTarget = CameraTarget.NONE;
            bindCamera(target);
            return;
        }

        pendingCameraTarget = CameraTarget.NONE;
        if (signalMode) {
            showSetup(getString(R.string.camera_permission_denied));
        } else {
            setSetupStatus(getString(R.string.camera_permission_denied), true);
        }
        new MaterialAlertDialogBuilder(this)
            .setTitle(R.string.camera_permission_title)
            .setMessage(R.string.camera_permission_message)
            .setPositiveButton(R.string.camera_permission_action, null)
            .show();
    }

    private void bindViews() {
        appRoot = findViewById(R.id.app_root);
        setupPanel = findViewById(R.id.setup_panel);
        signalPanel = findViewById(R.id.signal_panel);
        serverUrlLayout = findViewById(R.id.server_url_layout);
        serverUrlInput = findViewById(R.id.server_url_input);
        usernameInput = findViewById(R.id.username_input);
        passwordInput = findViewById(R.id.password_input);
        setupStatusText = findViewById(R.id.setup_status_text);
        signalStatusText = findViewById(R.id.signal_status_text);
        deviceValueText = findViewById(R.id.device_value_text);
        shipmentValueText = findViewById(R.id.shipment_value_text);
        allValuesText = findViewById(R.id.all_values_text);
        loginButton = findViewById(R.id.login_button);
        cancelActivationButton = findViewById(R.id.cancel_activation_button);
        setupProgress = findViewById(R.id.setup_progress);
        signalCameraPreview = findViewById(R.id.signal_camera_preview);
        cameraResultCover = findViewById(R.id.camera_result_cover);
        ImageButton signalSettingsButton = findViewById(R.id.signal_settings_button);
        signalSettingsButton.setOnClickListener(view -> showSetup(getString(R.string.setup_mode)));
    }

    private void applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(appRoot, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(
                bars.left,
                bars.top,
                bars.right,
                Math.max(bars.bottom, ime.bottom)
            );
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(appRoot);
    }

    private void configureInputsAndActions() {
        serverUrlLayout.setPlaceholderText(
            getString(BuildConfig.DEBUG
                ? R.string.server_url_hint_debug
                : R.string.server_url_hint_release)
        );
        serverUrlInput.setText(credentialStore.serverOrigin());
        setupProgress.setIndeterminate(true);

        loginButton.setOnClickListener(view -> login());
        cancelActivationButton.setOnClickListener(view -> cancelPendingActivation());
        passwordInput.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_DONE) {
                return false;
            }
            login();
            return true;
        });
    }

    private void login() {
        String serverUrl = inputText(serverUrlInput);
        String username = inputText(usernameInput).trim();
        String password = inputText(passwordInput);

        if (!isAllowedServerUrl(serverUrl)) {
            setSetupStatus(serverUrlValidationMessage(), true);
            return;
        }

        hideKeyboard();
        try {
            if (pendingActivation != null
                && !ServerOrigin.same(pendingActivation.serverOrigin, serverUrl)) {
                discardPendingActivation(pendingActivation);
            } else if (pendingRecoveryBlocked
                && !ServerOrigin.same(credentialStore.serverOrigin(), serverUrl)) {
                ProvisioningInbox.clear(this);
                credentialStore.clearCredentialMaterial();
                resetPendingActivationState();
            }
            credentialStore.switchOrigin(serverUrl);
            api.setBaseUrl(serverUrl);
            managedTrustBundle = trustStore.load(serverUrl);
            api.setManagedTrustBundle(managedTrustBundle);
            clientId = credentialStore.clientId(api.getBaseUrl());
            deviceToken = credentialStore.loadDeviceToken(api.getBaseUrl());
        } catch (Exception error) {
            setSetupStatus(userMessage(error), true);
            return;
        }
        runSetupApi(getString(R.string.login_in_progress), () -> {
            QuickHackApi.ApiResponse response = api.login(username, password);
            if (!response.isHttpOk() || !response.isQuickHackOk()) {
                throw new IllegalStateException(
                    response.messageOrDefault(getString(R.string.login_failed))
                );
            }

            if (provisioningRequest != null) {
                activateProvisioningRequest();
            }
            if (deviceToken == null || deviceToken.isEmpty()) {
                throw new IllegalStateException("QuickHack 클라이언트에서 실제 USB 기기 등록을 먼저 실행하세요.");
            }
            mainHandler.post(() -> {
                passwordInput.setText("");
                enterSignalMode();
            });
        });
    }

    private void activateProvisioningRequest() throws Exception {
        ProvisioningRequest request = provisioningRequest;
        if (request == null || !ServerOrigin.same(request.serverOrigin, api.getBaseUrl())) {
            throw new IllegalStateException("현재 서버에 대한 USB 기기 등록 요청이 없습니다.");
        }
        PendingActivationRecord record = preparePendingActivation(request);
        String currentProofSpki = proofKey.publicKeySpkiBase64();
        if (!record.proofPublicKeySpki.equals(currentProofSpki)) {
            pendingRecoveryBlocked = true;
            updateCancelActivationButton();
            throw new IllegalStateException(getString(R.string.activation_proof_changed));
        }
        String tokenDigest = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(
                record.deviceToken.getBytes(StandardCharsets.UTF_8)
            ),
            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
        );
        String proofMessage = "QH-MOBILE-PROVISION-V1\n"
            + record.deviceId + "\n"
            + record.registrationRevision + "\n"
            + record.provisioningToken + "\n"
            + record.appInstanceId + "\n"
            + tokenDigest;
        JSONObject body = new JSONObject();
        body.put("deviceId", record.deviceId);
        body.put("registrationRevision", record.registrationRevision);
        body.put("provisioningToken", record.provisioningToken);
        body.put("appInstanceId", record.appInstanceId);
        body.put("deviceToken", record.deviceToken);
        body.put("devicePublicKeySpki", record.proofPublicKeySpki);
        body.put("signature", proofKey.signBase64(proofMessage));
        QuickHackApi.ApiResponse response = api.activateDevice(body);
        if (!response.isHttpOk() || !response.isQuickHackOk()) {
            if (ActivationRecoveryPolicy.isTerminalFailure(response)) {
                discardPendingActivation(record);
            }
            throw new IllegalStateException(
                response.messageOrDefault(getString(R.string.activation_failed))
            );
        }
        JSONObject data = response.json == null ? null : response.json.optJSONObject("data");
        String returnedToken = data == null ? "" : data.optString("deviceToken", "");
        if (!record.deviceToken.equals(returnedToken)) {
            throw new IllegalStateException(getString(R.string.activation_token_missing));
        }
        credentialStore.saveDeviceToken(
            record.serverOrigin,
            record.appInstanceId,
            record.deviceToken
        );
        deviceToken = record.deviceToken;
        finalizePendingActivation(record);
    }

    private void handleProvisioningInbox() {
        try {
            PendingActivationRecord recovered = credentialStore.loadPendingActivation();
            if (recovered != null) {
                restorePendingActivation(recovered);
                return;
            }

            String encoded = ProvisioningInbox.peek(this);
            if (encoded.isEmpty()) {
                updateCancelActivationButton();
                return;
            }
            String json = new String(
                Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING),
                StandardCharsets.UTF_8
            );
            ProvisioningRequest parsed = ProvisioningRequest.parse(new JSONObject(json), encoded);
            if (!isAllowedServerUrl(parsed.serverOrigin)) {
                throw new IllegalArgumentException(serverUrlValidationMessage());
            }
            trustStore.save(parsed.trustBundle);
            managedTrustBundle = parsed.trustBundle;
            credentialStore.switchOrigin(parsed.serverOrigin);
            api.setBaseUrl(parsed.serverOrigin);
            api.setManagedTrustBundle(managedTrustBundle);
            clientId = credentialStore.clientId(parsed.serverOrigin);
            deviceToken = credentialStore.loadDeviceToken(parsed.serverOrigin);
            provisioningRequest = parsed;
            pendingActivation = null;
            pendingRecoveryBlocked = false;
            serverUrlInput.setText(parsed.serverOrigin);
            api.clearSession();
            showSetup(getString(R.string.setup_initial_activation));
            updateCancelActivationButton();
        } catch (Exception error) {
            pendingRecoveryBlocked = credentialStore.hasPendingActivation();
            if (!pendingRecoveryBlocked) {
                try {
                    String invalidPayload = ProvisioningInbox.peek(this);
                    if (!invalidPayload.isEmpty()) {
                        ProvisioningInbox.removeIfMatches(this, invalidPayload);
                    }
                } catch (Exception ignored) {
                    pendingRecoveryBlocked = true;
                }
            }
            provisioningRequest = null;
            pendingActivation = null;
            setSetupStatus(
                pendingRecoveryBlocked
                    ? getString(R.string.activation_recovery_blocked)
                    : getString(R.string.activation_failed),
                true
            );
            updateCancelActivationButton();
        }
    }

    private PendingActivationRecord preparePendingActivation(ProvisioningRequest request)
        throws Exception {
        if (pendingActivation != null) return pendingActivation;
        proofKey.ensureCreated();
        byte[] tokenBytes = new byte[32];
        new SecureRandom().nextBytes(tokenBytes);
        String generatedToken = Base64.encodeToString(
            tokenBytes,
            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
        );
        PendingActivationRecord created = PendingActivationRecord.create(
            request.serverOrigin,
            request.deviceId,
            request.registrationRevision,
            request.provisioningToken,
            clientId,
            generatedToken,
            proofKey.publicKeySpkiBase64(),
            request.trustBundle.identityDigestSha256,
            request.inboxPayload,
            System.currentTimeMillis()
        );
        credentialStore.savePendingActivation(created);
        pendingActivation = created;
        pendingRecoveryBlocked = false;
        updateCancelActivationButton();
        return created;
    }

    private void restorePendingActivation(PendingActivationRecord record) throws Exception {
        if (!isAllowedServerUrl(record.serverOrigin)) {
            throw new IllegalArgumentException(serverUrlValidationMessage());
        }
        credentialStore.switchOrigin(record.serverOrigin);
        ManagedTrustBundle recoveredTrust = trustStore.load(record.serverOrigin);
        if (
            recoveredTrust == null ||
            record.trustBundleDigestSha256.isEmpty() ||
            !record.trustBundleDigestSha256.equals(recoveredTrust.identityDigestSha256)
        ) {
            throw new IllegalStateException("Pending activation trust identity cannot be recovered.");
        }
        managedTrustBundle = recoveredTrust;
        api.setBaseUrl(record.serverOrigin);
        api.setManagedTrustBundle(managedTrustBundle);
        clientId = record.appInstanceId;
        deviceToken = credentialStore.loadDeviceToken(record.serverOrigin);
        pendingActivation = record;
        provisioningRequest = ProvisioningRequest.fromPending(record, recoveredTrust);
        pendingRecoveryBlocked = false;
        serverUrlInput.setText(record.serverOrigin);
        api.clearSession();

        ActivationRecoveryPolicy.StartupAction recoveryAction =
            ActivationRecoveryPolicy.startupAction(
                record,
                deviceToken,
                proofKey.publicKeySpkiBase64()
            );
        if (recoveryAction == ActivationRecoveryPolicy.StartupAction.BLOCK_PROOF_MISMATCH) {
            pendingRecoveryBlocked = true;
            showSetup(getString(R.string.activation_proof_changed));
            updateCancelActivationButton();
            return;
        }
        if (recoveryAction
            == ActivationRecoveryPolicy.StartupAction.FINALIZE_SAVED_CREDENTIAL) {
            finalizePendingActivation(record);
            showSetup(getString(R.string.setup_initial_login));
            return;
        }
        showSetup(getString(R.string.activation_recovery_ready));
        updateCancelActivationButton();
    }

    private void finalizePendingActivation(PendingActivationRecord record) throws Exception {
        ProvisioningInbox.removeIfMatches(this, record.inboxPayload);
        if (!credentialStore.clearPendingActivation(record)) {
            throw new IllegalStateException("Pending activation owner changed during finalization.");
        }
        resetPendingActivationState();
    }

    private void discardPendingActivation(PendingActivationRecord record) throws Exception {
        ProvisioningInbox.removeIfMatches(this, record.inboxPayload);
        credentialStore.clearCredentialMaterial();
        clientId = "";
        deviceToken = "";
        resetPendingActivationState();
    }

    private void cancelPendingActivation() {
        runSetupApi(getString(R.string.activation_cancelling), () -> {
            PendingActivationRecord record = pendingActivation;
            if (record != null) {
                discardPendingActivation(record);
            } else {
                ProvisioningInbox.clear(this);
                credentialStore.clearCredentialMaterial();
                clientId = "";
                deviceToken = "";
                resetPendingActivationState();
            }
            api.clearSession();
            mainHandler.post(() -> showSetup(getString(R.string.activation_cancelled)));
        });
    }

    private void resetPendingActivationState() {
        pendingActivation = null;
        provisioningRequest = null;
        pendingRecoveryBlocked = false;
        updateCancelActivationButton();
    }

    private void updateCancelActivationButton() {
        if (cancelActivationButton == null) return;
        mainHandler.post(() -> cancelActivationButton.setVisibility(
            pendingActivation != null || provisioningRequest != null || pendingRecoveryBlocked
                ? View.VISIBLE
                : View.GONE
        ));
    }

    private void enterSignalMode() {
        signalMode = true;
        if (pendingReset != null) {
            mainHandler.removeCallbacks(pendingReset);
        }
        hideKeyboard();
        setupPanel.setVisibility(View.GONE);
        signalPanel.setVisibility(View.VISIBLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        resetScanState();
        setSignalNeutral(R.string.signal_scan);
        requestCamera(CameraTarget.OPERATION);
    }

    private void showSetup(String message) {
        signalMode = false;
        busy = false;
        pendingCameraTarget = CameraTarget.NONE;
        if (pendingReset != null) {
            mainHandler.removeCallbacks(pendingReset);
        }
        if (cameraController != null) {
            cameraController.stop();
        }
        setupPanel.setVisibility(View.VISIBLE);
        signalPanel.setVisibility(View.GONE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        appRoot.setBackgroundColor(color(R.color.qh_background));
        applySystemBarColors(R.color.qh_background, true);
        setSetupStatus(message, false);
    }

    private void requestCamera(CameraTarget target) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) {
            bindCamera(target);
            return;
        }
        pendingCameraTarget = target;
        ActivityCompat.requestPermissions(
            this,
            new String[] { Manifest.permission.CAMERA },
            CAMERA_PERMISSION_REQUEST
        );
    }

    private void bindCamera(CameraTarget target) {
        if (target == CameraTarget.OPERATION) {
            cameraController.bind(signalCameraPreview, new BarcodeCameraController.Listener() {
                @Override
                public void onBarcode(String value) {
                    handleOperationScan(value);
                }

                @Override
                public void onError(Throwable error) {
                    if (signalMode && !busy) {
                        allValuesText.setText(R.string.camera_start_failed);
                    }
                }
            });
        }
    }

    private void handleOperationScan(String value) {
        if (!signalMode || busy || scannedValues.contains(value)) {
            return;
        }
        scannedValues.add(value);
        applyDisplayClassification(value);
        updateValueDisplay();

        if (scannedValues.size() < 2) {
            setSignalNeutral(R.string.signal_scan_next);
            return;
        }

        cameraController.pauseAnalysis();
        runPackingCheck();
    }

    private void applyDisplayClassification(String value) {
        String normalized = normalizeScan(value);
        boolean looksLikeDevice =
            PG_PATTERN.matcher(normalized).matches()
                || IMEI_PATTERN.matcher(normalized).matches();
        if (looksLikeDevice) {
            deviceValueText.setText(value);
        } else {
            shipmentValueText.setText(value);
        }
    }

    private void updateValueDisplay() {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < scannedValues.size(); index += 1) {
            if (index > 0) {
                builder.append("  |  ");
            }
            builder.append(scannedValues.get(index));
        }
        allValuesText.setText(builder.toString());
    }

    private void runPackingCheck() {
        if (busy) {
            return;
        }
        if (deviceToken == null || deviceToken.isEmpty()) {
            setSignalFailure(R.string.signal_no_device_token);
            scheduleResetAndResume(2500);
            return;
        }

        busy = true;
        setSignalNeutral(R.string.signal_check);
        List<String> values = new ArrayList<>(scannedValues);
        executor.execute(() -> {
            try {
                QuickHackApi.ApiResponse response =
                    api.packingCheck(values, clientId, deviceToken);
                if (!response.isHttpOk() || !response.isQuickHackOk()) {
                    if (
                        response.code == 401 ||
                        response.code == 403 ||
                        "MOBILE_DEVICE_AUTH_FAILED".equals(response.errorCode()) ||
                        "MOBILE_AUTHORIZATION_CHANGED".equals(response.errorCode())
                    ) {
                        credentialStore.clearCredentialMaterial();
                        deviceToken = "";
                    }
                    throw new IllegalStateException(
                        response.messageOrDefault(getString(R.string.packing_check_failed))
                    );
                }

                JSONObject data = response.json.optJSONObject("data");
                if (data == null) {
                    throw new IllegalStateException(getString(R.string.packing_result_missing));
                }

                boolean matched = data.optBoolean("matched", false);
                String code = data.optString("code", "");
                mainHandler.post(() -> {
                    busy = false;
                    if (matched) {
                        setSignalSuccess();
                        playSuccessTone();
                        scheduleResetAndResume(900);
                    } else if ("MISSING_INPUT".equals(code)) {
                        setSignalNeutral(R.string.signal_scan_next);
                        cameraController.resumeAnalysis();
                    } else {
                        setSignalFailure(R.string.signal_failure);
                        playFailureAlarm();
                        scheduleResetAndResume(3500);
                    }
                });
            } catch (Exception error) {
                mainHandler.post(() -> {
                    busy = false;
                    if (deviceToken == null || deviceToken.isEmpty()) {
                        showSetup("기기 또는 계정 보안 상태가 변경되었습니다. USB로 다시 등록하세요.");
                        return;
                    }
                    setSignalFailure(R.string.signal_failure);
                    allValuesText.setText(userMessage(error));
                    playFailureAlarm();
                    scheduleResetAndResume(3500);
                });
            }
        });
    }

    private void resetScanState() {
        scannedValues.clear();
        deviceValueText.setText(R.string.empty_value);
        shipmentValueText.setText(R.string.empty_value);
        allValuesText.setText("");
    }

    private void scheduleResetAndResume(int delayMs) {
        if (pendingReset != null) {
            mainHandler.removeCallbacks(pendingReset);
        }
        pendingReset = () -> {
            pendingReset = null;
            if (!signalMode) {
                return;
            }
            busy = false;
            resetScanState();
            setSignalNeutral(R.string.signal_scan);
            cameraController.resumeAnalysis();
        };
        mainHandler.postDelayed(pendingReset, delayMs);
    }

    private void setSignalNeutral(int statusResource) {
        int color = color(R.color.qh_signal_neutral);
        appRoot.setBackgroundColor(color);
        signalPanel.setBackgroundColor(color);
        signalStatusText.setText(statusResource);
        cameraResultCover.setVisibility(View.GONE);
        applySystemBarColors(R.color.qh_signal_neutral, false);
    }

    private void setSignalSuccess() {
        int color = color(R.color.qh_success);
        appRoot.setBackgroundColor(color);
        signalPanel.setBackgroundColor(color);
        signalStatusText.setText(R.string.signal_success);
        cameraResultCover.setBackgroundColor(color);
        cameraResultCover.setVisibility(View.VISIBLE);
        applySystemBarColors(R.color.qh_success, false);
    }

    private void setSignalFailure(int statusResource) {
        int color = color(R.color.qh_error);
        appRoot.setBackgroundColor(color);
        signalPanel.setBackgroundColor(color);
        signalStatusText.setText(statusResource);
        cameraResultCover.setBackgroundColor(color);
        cameraResultCover.setVisibility(View.VISIBLE);
        applySystemBarColors(R.color.qh_error, false);
    }

    private void applySystemBarColors(int colorResource, boolean lightIcons) {
        int backgroundColor = color(colorResource);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(backgroundColor);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), appRoot);
        controller.setAppearanceLightStatusBars(lightIcons);
        controller.setAppearanceLightNavigationBars(lightIcons);
    }

    private void runSetupApi(String busyText, ApiCall call) {
        setSetupBusy(true);
        setSetupStatus(busyText, false);
        executor.execute(() -> {
            try {
                call.run();
            } catch (Exception error) {
                mainHandler.post(() -> setSetupStatus(userMessage(error), true));
            } finally {
                mainHandler.post(() -> setSetupBusy(false));
            }
        });
    }

    private void setSetupBusy(boolean busyValue) {
        setupProgress.setVisibility(busyValue ? View.VISIBLE : View.GONE);
        loginButton.setEnabled(!busyValue);
        cancelActivationButton.setEnabled(!busyValue);
        serverUrlInput.setEnabled(!busyValue);
        usernameInput.setEnabled(!busyValue);
        passwordInput.setEnabled(!busyValue);
    }

    private void setSetupStatus(String message, boolean error) {
        setupStatusText.setText(message);
        setupStatusText.setTextColor(color(error ? R.color.qh_error : R.color.qh_muted));
        setupStatusText.setBackgroundResource(
            error ? R.drawable.bg_status_error : R.drawable.bg_status_neutral
        );
    }

    private String userMessage(Exception error) {
        if (error instanceof SocketTimeoutException) {
            return getString(R.string.server_timeout);
        }
        if (error instanceof ConnectException
            || error instanceof UnknownHostException
            || error instanceof IOException) {
            return getString(R.string.server_connection_failed);
        }
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? getString(R.string.packing_check_failed)
            : message;
    }

    private String normalizeScan(String value) {
        return String.valueOf(value)
            .trim()
            .toUpperCase(Locale.ROOT)
            .replaceAll("[^A-Z0-9]", "");
    }

    private boolean isAllowedServerUrl(String value) {
        Uri uri = Uri.parse(String.valueOf(value).trim());
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || host.trim().isEmpty()) {
            return false;
        }
        if ("https".equalsIgnoreCase(scheme)) {
            return true;
        }
        return BuildConfig.DEBUG
            && "http".equalsIgnoreCase(scheme)
            && uri.getPort() == 3000
            && isPrivateLanHost(host);
    }

    private boolean isPrivateLanHost(String host) {
        String normalized = String.valueOf(host).trim().toLowerCase(Locale.ROOT);
        if ("localhost".equals(normalized) || "127.0.0.1".equals(normalized)) {
            return true;
        }

        String[] parts = normalized.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        int[] octets = new int[4];
        try {
            for (int index = 0; index < parts.length; index += 1) {
                octets[index] = Integer.parseInt(parts[index]);
                if (octets[index] < 0 || octets[index] > 255) {
                    return false;
                }
            }
        } catch (NumberFormatException ignored) {
            return false;
        }
        return octets[0] == 10
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
    }

    private String serverUrlValidationMessage() {
        return getString(BuildConfig.DEBUG
            ? R.string.server_url_debug_required
            : R.string.server_url_https_required);
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused == null) {
            return;
        }
        InputMethodManager manager =
            (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (manager != null) {
            manager.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
        focused.clearFocus();
    }

    private String inputText(TextInputEditText input) {
        return input.getText() == null ? "" : input.getText().toString();
    }

    private int color(int resource) {
        return ContextCompat.getColor(this, resource);
    }

    private void playFailureAlarm() {
        ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
        tone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 1000);
        mainHandler.postDelayed(tone::release, 1200);
        Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(
                VibrationEffect.createOneShot(650, VibrationEffect.DEFAULT_AMPLITUDE)
            );
        } else {
            vibrator.vibrate(650);
        }
    }

    private void playSuccessTone() {
        ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70);
        tone.startTone(ToneGenerator.TONE_PROP_ACK, 150);
        mainHandler.postDelayed(tone::release, 300);
    }

    private static final class ProvisioningRequest {
        final String serverOrigin;
        final int deviceId;
        final int registrationRevision;
        final String provisioningToken;
        final ManagedTrustBundle trustBundle;
        final String inboxPayload;

        ProvisioningRequest(
            String serverOrigin,
            int deviceId,
            int registrationRevision,
            String provisioningToken,
            ManagedTrustBundle trustBundle,
            String inboxPayload
        ) {
            this.serverOrigin = serverOrigin;
            this.deviceId = deviceId;
            this.registrationRevision = registrationRevision;
            this.provisioningToken = provisioningToken;
            this.trustBundle = trustBundle;
            this.inboxPayload = inboxPayload;
        }

        static ProvisioningRequest parse(JSONObject json, String inboxPayload) {
            if (json.optInt("version", 0) != 1) {
                throw new IllegalArgumentException("Unsupported provisioning version.");
            }
            String origin = ServerOrigin.normalize(json.optString("serverOrigin", ""));
            int deviceId = json.optInt("deviceId", 0);
            int revision = json.optInt("registrationRevision", -1);
            String token = json.optString("provisioningToken", "");
            ManagedTrustBundle trustBundle;
            try {
                trustBundle = ManagedTrustBundle.parse(json.getJSONObject("trustBundle"));
            } catch (Exception error) {
                throw new IllegalArgumentException("Invalid managed trust bundle.", error);
            }
            if (!ServerOrigin.same(origin, trustBundle.origin)) {
                throw new IllegalArgumentException("Provisioning origin does not match managed trust.");
            }
            if (deviceId <= 0 || revision < 0 || token.length() < 32) {
                throw new IllegalArgumentException("Invalid provisioning payload.");
            }
            return new ProvisioningRequest(
                origin,
                deviceId,
                revision,
                token,
                trustBundle,
                inboxPayload
            );
        }

        static ProvisioningRequest fromPending(
            PendingActivationRecord record,
            ManagedTrustBundle trustBundle
        ) {
            return new ProvisioningRequest(
                record.serverOrigin,
                record.deviceId,
                record.registrationRevision,
                record.provisioningToken,
                trustBundle,
                record.inboxPayload
            );
        }
    }

    private interface ApiCall {
        void run() throws Exception;
    }

    private enum CameraTarget {
        NONE,
        OPERATION
    }
}
