import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalPrinter, localPrinterErrorResponse } from "./printer-auth";
import { getLocalPrintJob } from "@/quickhack_client/printing/printer-service";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ requestKey?: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authorizeLocalPrinter(request);
  if (auth.response) return auth.response;
  const params = await context.params;
  try {
    const job = getLocalPrintJob(params.requestKey);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    return localPrinterErrorResponse(error);
  }
}

