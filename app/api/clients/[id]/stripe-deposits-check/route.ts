import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { fetchStripeDeposits } from "@/lib/qbo-stripe-recon";

// Always live — must reflect the QBO state in real time.
export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/stripe-deposits-check?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Lightweight: hits QBO and counts Stripe-tagged deposits in a date
 * range. Used by the Bank Rules → Stripe Recon handoff so the
 * bookkeeper can skip the recon entirely when there are zero deposits
 * to reconcile in this cleanup's window — sparing them a useless trip
 * through the recon form just to be told "0 deposits found."
 *
 * Returns:
 *   { count: number, total_amount: number, sample: [{...}] (first 3) }
 *
 * Doesn't write to the DB. Idempotent. Cheap to call repeatedly.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end (YYYY-MM-DD) query params are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let deposits;
  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    deposits = await fetchStripeDeposits(
      (client as any).qbo_realm_id,
      accessToken,
      start,
      end
    );
  } catch (err: any) {
    // Fail-open: if we can't reach QBO, treat as "unknown" so the UI
    // falls back to the normal recon flow rather than silently skipping it.
    console.warn(`[stripe-deposits-check] QBO fetch failed for ${clientLinkId}:`, err?.message);
    return NextResponse.json({
      count: null,
      total_amount: null,
      error: "Could not query QBO for Stripe deposits — falling back to standard recon flow.",
    });
  }

  const total = deposits.reduce((s, d) => s + Number(d.amount || 0), 0);
  return NextResponse.json({
    count: deposits.length,
    total_amount: total,
    sample: deposits.slice(0, 3).map((d) => ({
      date: d.date,
      amount: d.amount,
      memo: (d.memo || "").slice(0, 80),
    })),
  });
}
