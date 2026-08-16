import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalPrinter, localPrinterErrorResponse } from "./printer-auth";
import {
  getPrinterSettings,
  savePrinterSettings,
} from "@/quickhack_client/printing/printer-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeLocalPrinter(request);
  if (auth.response) return auth.response;
  return NextResponse.json({ ok: true, settings: getPrinterSettings() });
}

export async function PUT(request: NextRequest) {
  const auth = await authorizeLocalPrinter(request);
  if (auth.response) return auth.response;
  try {
    const body = await request.json();
    return NextResponse.json({
      ok: true,
      settings: savePrinterSettings(body),
    });
  } catch (error) {
    return localPrinterErrorResponse(error);
  }
}

