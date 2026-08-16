package com.quickhack.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

import androidx.annotation.Nullable;

public final class ScanGuideView extends View {
    private final Paint scrimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint guidePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path scrimPath = new Path();
    private final RectF guideRect = new RectF();

    public ScanGuideView(Context context) {
        this(context, null);
    }

    public ScanGuideView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        scrimPaint.setColor(0x66000000);
        scrimPaint.setStyle(Paint.Style.FILL);
        guidePaint.setColor(0xFFFFFFFF);
        guidePaint.setStrokeWidth(dp(3));
        guidePaint.setStrokeCap(Paint.Cap.SQUARE);
        guidePaint.setStyle(Paint.Style.STROKE);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float horizontalInset = getWidth() * 0.12f;
        float guideHeight = Math.min(dp(104), getHeight() * 0.48f);
        float top = (getHeight() - guideHeight) / 2f;
        guideRect.set(horizontalInset, top, getWidth() - horizontalInset, top + guideHeight);

        scrimPath.reset();
        scrimPath.setFillType(Path.FillType.EVEN_ODD);
        scrimPath.addRect(0, 0, getWidth(), getHeight(), Path.Direction.CW);
        scrimPath.addRoundRect(guideRect, dp(6), dp(6), Path.Direction.CCW);
        canvas.drawPath(scrimPath, scrimPaint);

        float corner = Math.min(dp(28), guideRect.width() * 0.12f);
        drawCorner(canvas, guideRect.left, guideRect.top, corner, 1, 1);
        drawCorner(canvas, guideRect.right, guideRect.top, corner, -1, 1);
        drawCorner(canvas, guideRect.left, guideRect.bottom, corner, 1, -1);
        drawCorner(canvas, guideRect.right, guideRect.bottom, corner, -1, -1);
    }

    private void drawCorner(
        Canvas canvas,
        float x,
        float y,
        float length,
        int horizontalDirection,
        int verticalDirection
    ) {
        canvas.drawLine(x, y, x + length * horizontalDirection, y, guidePaint);
        canvas.drawLine(x, y, x, y + length * verticalDirection, guidePaint);
    }

    private float dp(int value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
