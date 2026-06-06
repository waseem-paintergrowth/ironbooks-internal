import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildFleetSnapshot, type Severity } from "@/lib/fleet-health";

/**
 * GET /api/fleet/health
 *
 * Returns one FleetSnapshot covering every active client.
 * Query params:
 *   ?bookkeeper_id=<uuid>  — filter to one bookkeeper's portfolio
 *   ?severity=failing|warning|healthy
 *   ?search=<text>         — fuzzy match on client name / error message
 *
 * Admin + lead only. Bookkeepers see their own portfolio via the
 * bookkeeper_id filter on the same endpoint.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  const isSenior = ["admin", "lead"].includes(role);
  // Bookkeepers can hit this endpoint but only see their own portfolio.
  // We force-filter their bookkeeper_id server-side so they can't fish.
  const url = new URL(request.url);
  const explicitBkId = url.searchParams.get("bookkeeper_id") || null;
  const bookkeeperId = isSenior
    ? explicitBkId
    : user.id; // non-seniors locked to their portfolio
  const severityRaw = (url.searchParams.get("severity") || "").toLowerCase();
  const severity: Severity | null =
    severityRaw === "failing" || severityRaw === "warning" || severityRaw === "healthy"
      ? (severityRaw as Severity)
      : null;
  const search = url.searchParams.get("search") || null;

  try {
    const snapshot = await buildFleetSnapshot(service as any, {
      bookkeeperId,
      severity,
      search,
    });
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    console.error("[fleet/health] failed:", err);
    return NextResponse.json(
      { error: err?.message || "Fleet health snapshot failed" },
      { status: 500 }
    );
  }
}
