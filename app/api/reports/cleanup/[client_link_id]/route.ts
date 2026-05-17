import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { buildCleanupReportData } from "@/lib/cleanup-report-data";
import { CleanupReportPDF } from "@/lib/cleanup-report-pdf";

export const runtime = "nodejs"; // @react-pdf needs Node, not Edge
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/reports/cleanup/[client_link_id]?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Generates the branded cleanup-summary PDF for a client across all jobs
 * completed in the given window. Streams the PDF as a download. Filename
 * is "Ironbooks Cleanup — {Client Name} — {start_end}.pdf".
 *
 * Auth: any signed-in bookkeeper. The endpoint doesn't expose data outside
 * of what the bookkeeper can already see in the app.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ client_link_id: string }> }
) {
  const { client_link_id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end query params (YYYY-MM-DD) are required" },
      { status: 400 }
    );
  }

  // Sanity-check the date format — anything goes wrong here we'd rather
  // tell the bookkeeper than burn 30s building an empty PDF.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json(
      { error: "start and end must be YYYY-MM-DD" },
      { status: 400 }
    );
  }
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return NextResponse.json(
      { error: "end date must be >= start date" },
      { status: 400 }
    );
  }

  const originUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `${url.protocol}//${url.host}`;

  let data;
  try {
    data = await buildCleanupReportData({
      client_link_id,
      period_start: start,
      period_end: end,
      bookkeeper_user_id: user.id,
      origin_url: originUrl,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = (await renderToBuffer(
      // @ts-expect-error react-pdf accepts a Document element here
      React.createElement(CleanupReportPDF, { data })
    )) as Buffer;
  } catch (err: any) {
    console.error("[reports/cleanup] PDF render failed:", err);
    return NextResponse.json(
      { error: `PDF generation failed: ${err.message}` },
      { status: 500 }
    );
  }

  const safeClient = data.client_name.replace(/[^A-Za-z0-9 .\-_]+/g, "").trim() || "Client";
  const filename = `Ironbooks Cleanup — ${safeClient} — ${start}_${end}.pdf`;

  return new NextResponse(pdfBuffer as any, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "no-store",
    },
  });
}
