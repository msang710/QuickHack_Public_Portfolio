"use client";

import {
  LOGEN_LABEL_TEMPLATE,
  type LogenLabelDto,
} from "@/quickhack_shared/shipment/logen-label";

type RenderedLabel = {
  issueItemId: number;
  issueSequence: number;
  trackingNumber: string;
  bitmapBase64: string;
  previewDataUrl: string;
};

function fitText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number
) {
  const text = value.trim();
  if (context.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (
    shortened.length > 1 &&
    context.measureText(`${shortened}…`).width > maxWidth
  ) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}…`;
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number
) {
  context.fillText(fitText(context, value, maxWidth), x, y);
}

function wrapText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
) {
  const characters = Array.from(value.trim());
  const lines: string[] = [];
  let current = "";
  for (const character of characters) {
    const candidate = current + character;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  const consumed = lines.join("").length;
  if (consumed < characters.length && lines.length > 0) {
    lines[lines.length - 1] = fitText(
      context,
      `${lines[lines.length - 1]}${characters.slice(consumed).join("")}`,
      maxWidth
    );
  }
  lines.forEach((line, index) =>
    context.fillText(line, x, y + index * lineHeight)
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length))
    );
  }
  return btoa(binary);
}

function packMonochromeBitmap(context: CanvasRenderingContext2D) {
  const { widthDots, lengthDots } = LOGEN_LABEL_TEMPLATE;
  const pixels = context.getImageData(0, 0, widthDots, lengthDots).data;
  const widthBytes = widthDots / 8;
  const output = new Uint8Array(widthBytes * lengthDots);
  for (let y = 0; y < lengthDots; y += 1) {
    for (let x = 0; x < widthDots; x += 1) {
      const pixelIndex = (y * widthDots + x) * 4;
      const luminance =
        pixels[pixelIndex] * 0.299 +
        pixels[pixelIndex + 1] * 0.587 +
        pixels[pixelIndex + 2] * 0.114;
      if (pixels[pixelIndex + 3] > 0 && luminance < 210) {
        const byteIndex = y * widthBytes + Math.floor(x / 8);
        output[byteIndex] |= 0x80 >> (x % 8);
      }
    }
  }
  return output;
}

export function renderLogenLabelBitmap(label: LogenLabelDto): RenderedLabel {
  const canvas = document.createElement("canvas");
  canvas.width = LOGEN_LABEL_TEMPLATE.widthDots;
  canvas.height = LOGEN_LABEL_TEMPLATE.lengthDots;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("The browser could not create the label canvas.");
  }

  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.textBaseline = "top";
  context.font = '700 54px "Malgun Gothic", sans-serif';
  drawFittedText(
    context,
    label.classification.classCode,
    42,
    42,
    300
  );
  context.font = '700 30px "Malgun Gothic", sans-serif';
  drawFittedText(
    context,
    label.classification.terminalName ||
      label.classification.salesOfficeName,
    390,
    54,
    350
  );
  context.font = '700 42px "Malgun Gothic", sans-serif';
  drawFittedText(context, label.receiver.name, 42, 150, 360);
  context.font = '600 29px "Malgun Gothic", sans-serif';
  drawFittedText(context, label.receiver.phone, 42, 208, 360);
  context.font = '600 28px "Malgun Gothic", sans-serif';
  wrapText(
    context,
    `${label.receiver.postCode} ${label.receiver.address1} ${label.receiver.address2}`,
    42,
    260,
    700,
    38,
    3
  );
  context.font = '700 31px "Malgun Gothic", sans-serif';
  drawFittedText(
    context,
    `${label.classification.branchCode} ${label.classification.dongName}`,
    42,
    388,
    700
  );
  context.font = '600 26px "Malgun Gothic", sans-serif';
  drawFittedText(context, label.receiver.memo, 42, 440, 700);
  context.font = '700 28px "Malgun Gothic", sans-serif';
  wrapText(context, label.parcel.goodsName, 42, 530, 700, 36, 2);
  context.font = '600 24px "Malgun Gothic", sans-serif';
  drawFittedText(
    context,
    `합포장 ${label.parcel.packageMemberCount}건 · ${label.parcel.pgNos.join(
      ", "
    )}`,
    42,
    620,
    700
  );
  context.font = '600 25px "Malgun Gothic", sans-serif';
  wrapText(
    context,
    `${label.sender.name} ${label.sender.tel} ${label.sender.address1} ${label.sender.address2}`,
    42,
    700,
    350,
    32,
    3
  );
  context.font = '700 28px "Arial", sans-serif';
  drawFittedText(context, label.trackingNumber, 470, 910, 290);
  context.font = '600 22px "Arial", sans-serif';
  context.fillText(
    `${label.issueSequence}/${label.parcel.takeDate}`,
    42,
    940
  );

  return {
    issueItemId: label.issueItemId,
    issueSequence: label.issueSequence,
    trackingNumber: label.trackingNumber,
    bitmapBase64: bytesToBase64(packMonochromeBitmap(context)),
    previewDataUrl: canvas.toDataURL("image/png"),
  };
}

