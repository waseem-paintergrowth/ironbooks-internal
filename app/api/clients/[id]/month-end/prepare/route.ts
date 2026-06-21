import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { defaultDeliveryPeriod, periodBounds, upsertDraftPackage } from "@/lib/month-end";
import { generateSummaryForPackage } from "@/lib/month-end/generate-summaries";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/clients/[id]/month-end/prepare  — admin/lead only.
 *
 * Step 1 of the single-client "Close & send statements" flow. Builds (or
 * re-uses) the month-end package for the period, generates the client-facing
 * summary, and returns it for review — WITHOUT sending anything. The actual
 * publish+email happens in .../month-end/send after the bookkeeper confirms.
 *
 * Body (optional): { period_year, period_month } — defaults to last month.
 * Returns one of:
 *   { status: "ready", packageId, period, summary, recipient }
 *   { status: "not_ready", period, blockReasons, recipient }
 *   { status: "sent", period, packageId, summary, recipient }
 *   { status: "error", error }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const ref = body.period_year && body.period_month
    ? { periodYear: Number(body.period_year), periodMonth: Number(body.period_month) }
    : defaultDeliveryPeriod();
  const period = periodBounds(ref);

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Who will receive it (for the confirm copy).
  let recipient: { name: string | null; email: string | null } | null = null;
  try {
    const { data: cu } = await (service as any)
      .from("client_users").select("user_id").eq("client_link_id", id).eq("active", true);
    const ids = ((cu as any[]) || []).map((m) => m.user_id).filter(Boolean);
    if (ids.length) {
      const { data: us } = await service.from("users").select("full_name, email").in("id", ids);
      const u = ((us as any[]) || [])[0];
      if (u) recipient = { name: u.full_name, email: u.email };
    }
  } catch { /* recipient is best-effort display only */ }

  const base = { period: period.label, recipient };

  // Already sent for this period?
  const { data: existing } = await service
    .from("month_end_packages")
    .select("id, status, ai_summary")
    .eq("client_link_id", id)
    .eq("period_year", period.periodYear)
    .eq("period_month", period.periodMonth)
    .maybeSingle();
  if ((existing as any)?.status === "sent") {
    return NextResponse.json({ status: "sent", packageId: (existing as any).id, summary: (existing as any).ai_summary, ...base });
  }

  // Build the package (runs the operational gate — QBO connected, categorized,
  // no pending items). A gate failure becomes a clean "not_ready" with reasons.
  let packageId = (existing as any)?.id as string | undefined;
  try {
    if (!packageId) {
      const built = await upsertDraftPackage(service as any, id, ref, user.id, {});
      packageId = built.packageId;
    }
  } catch (e: any) {
    const msg = e?.message || "Build failed";
    if (/not ready to build/i.test(msg)) {
      const reasons = msg.replace(/^.*not ready to build:\s*/i, "").split(",").map((s: string) => s.trim()).filter(Boolean);
      return NextResponse.json({ status: "not_ready", blockReasons: reasons, ...base });
    }
    return NextResponse.json({ status: "error", error: msg, ...base }, { status: 500 });
  }

  // Generate the client-facing summary if we don't have one yet.
  try {
    const { data: pk } = await service.from("month_end_packages").select("ai_summary").eq("id", packageId!).single();
    if (!(pk as any)?.ai_summary) {
      const r = await generateSummaryForPackage(service as any, packageId!);
      if (!r.ok) return NextResponse.json({ status: "error", error: r.error || "Summary generation failed", packageId, ...base }, { status: 500 });
    }
  } catch (e: any) {
    return NextResponse.json({ status: "error", error: e?.message || "Summary generation failed", packageId, ...base }, { status: 500 });
  }

  const { data: ready } = await service.from("month_end_packages").select("ai_summary").eq("id", packageId!).single();
  return NextResponse.json({ status: "ready", packageId, summary: (ready as any)?.ai_summary || null, ...base });
}
