import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalPrinter, localPrinterErrorResponse } from "./printer-auth";
import { printCalibrationLabel } from "@/quickhack_client/printing/printer-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizeLocalPrinter(request);
  if (auth.response) return auth.response;
  try {
    const body = await request.json();
    const job = await printCalibrationLabel(body?.printerName);
    return NextResponse.json({ ok: job.status === "SPOOLED", job });
  } catch (error) {
    return localPrinterErrorResponse(error);
  }
}

