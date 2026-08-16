package com.quickhack.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class BarcodeCameraController implements AutoCloseable {
    interface Listener {
        void onBarcode(String value);

        void onError(Throwable error);
    }

    private static final long DUPLICATE_SUPPRESSION_MS = 1400L;

    private final Context context;
    private final LifecycleOwner lifecycleOwner;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
    private final BarcodeScanner scanner = BarcodeScanning.getClient();
    private final AtomicBoolean frameInFlight = new AtomicBoolean(false);

    private ProcessCameraProvider cameraProvider;
    private Listener listener;
    private volatile boolean analysisEnabled;
    private volatile boolean closed;
    private int bindGeneration;
    private String lastValue = "";
    private long lastReportedAt;

    BarcodeCameraController(Context context, LifecycleOwner lifecycleOwner) {
        this.context = context.getApplicationContext();
        this.lifecycleOwner = lifecycleOwner;
    }

    void bind(PreviewView previewView, Listener listener) {
        if (closed) {
            return;
        }
        this.listener = listener;
        this.analysisEnabled = true;
        this.lastValue = "";
        this.lastReportedAt = 0L;
        int generation = ++bindGeneration;

        ListenableFuture<ProcessCameraProvider> providerFuture =
            ProcessCameraProvider.getInstance(context);
        providerFuture.addListener(() -> {
            try {
                if (closed || generation != bindGeneration) {
                    return;
                }
                cameraProvider = providerFuture.get();
                bindUseCases(cameraProvider, previewView);
            } catch (Exception error) {
                reportError(error);
            }
        }, ContextCompat.getMainExecutor(context));
    }

    void pauseAnalysis() {
        analysisEnabled = false;
    }

    void resumeAnalysis() {
        if (!closed) {
            lastValue = "";
            lastReportedAt = 0L;
            analysisEnabled = true;
        }
    }

    void stop() {
        analysisEnabled = false;
        bindGeneration += 1;
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
    }

    private void bindUseCases(ProcessCameraProvider provider, PreviewView previewView) {
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        ImageAnalysis analysis = new ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build();
        analysis.setAnalyzer(analysisExecutor, this::analyzeBarcode);

        provider.unbindAll();
        provider.bindToLifecycle(
            lifecycleOwner,
            CameraSelector.DEFAULT_FRONT_CAMERA,
            preview,
            analysis
        );
    }

    @OptIn(markerClass = ExperimentalGetImage.class)
    private void analyzeBarcode(ImageProxy imageProxy) {
        if (closed || !analysisEnabled || !frameInFlight.compareAndSet(false, true)) {
            imageProxy.close();
            return;
        }
        if (imageProxy.getImage() == null) {
            frameInFlight.set(false);
            imageProxy.close();
            return;
        }

        InputImage image = InputImage.fromMediaImage(
            imageProxy.getImage(),
            imageProxy.getImageInfo().getRotationDegrees()
        );
        scanner.process(image)
            .addOnSuccessListener(this::handleBarcodes)
            .addOnFailureListener(this::reportError)
            .addOnCompleteListener(task -> {
                frameInFlight.set(false);
                imageProxy.close();
            });
    }

    private void handleBarcodes(List<Barcode> barcodes) {
        if (closed || !analysisEnabled || barcodes == null) {
            return;
        }
        for (Barcode barcode : barcodes) {
            String rawValue = barcode.getRawValue();
            String value = rawValue == null ? "" : rawValue.trim();
            if (value.isEmpty()) {
                continue;
            }

            long now = System.currentTimeMillis();
            if (value.equals(lastValue) && now - lastReportedAt < DUPLICATE_SUPPRESSION_MS) {
                return;
            }
            lastValue = value;
            lastReportedAt = now;
            Listener currentListener = listener;
            if (currentListener != null) {
                mainHandler.post(() -> currentListener.onBarcode(value));
            }
            return;
        }
    }

    private void reportError(Throwable error) {
        Listener currentListener = listener;
        if (currentListener != null && !closed) {
            mainHandler.post(() -> currentListener.onError(error));
        }
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        stop();
        analysisExecutor.shutdownNow();
        scanner.close();
        listener = null;
    }
}
