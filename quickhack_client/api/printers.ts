import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalPrinter, localPrinterErrorResponse } from "./printer-auth";
import {
  getPrinterSettings,
  listPrinters,
} from "@/quickhack_client/printing/printer-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeLocalPrinter(request);
  if (auth.response) return auth.response;
  try {
    const printers = await listPrinters();
    return NextResponse.json({
      ok: true,
      printers,
      settings: getPrinterSettings(),
    });
  } catch (error) {
    return localPrinterErrorResponse(error);
  }
}

