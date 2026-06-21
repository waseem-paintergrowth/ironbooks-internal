import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { proposeStripeMatch, type ClientMatchProposal } from "@/lib/stripe-customer-match";
import { getStripeCustomer } from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED = new Set(["admin", "lead"]);

async function requireSenior() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!ALLOWED.has((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 }) };
  }
  return { user, service };
}

/** Run async fn over items with a small concurrency cap (Stripe rate limits). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * GET /api/admin/billing/backfill-stripe — DRY RUN (no writes).
 *
 * Proposes a Stripe customer for every client that has no stripe_customer_id,
 * matching by email / custom domain / company name. Returns a review report;
 * POST applies the approved subset.
 */
export async function GET() {
  const auth = await requireSenior();
  if ("error" in auth) return auth.error;
  const { service } = auth;

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ configured: false, proposals: [], summary: { unlinked: 0 } });
  }

  const { data: clients } = await (service as any)
    .from("client_links")
    .select("id, client_name, client_email")
    .is("stripe_customer_id", null)
    .eq("is_active", true);
  const rows = (clients as any[]) || [];

  // Gather portal-user emails per client so matching can try those too.
  const ids = rows.map((r) => r.id);
  const emailsByClient = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = new Set<string>();
    if (r.client_email) set.add(String(r.client_email));
    emailsByClient.set(r.id, set);
  }
  if (ids.length > 0) {
    const { data: maps } = await (service as any)
      .from("client_users")
      .select("client_link_id, user_id")
      .in("client_link_id", ids)
      .eq("active", true);
    const userIds = Array.from(new Set(((maps as any[]) || []).map((m: any) => m.user_id)));
    if (userIds.length > 0) {
      const { data: users } = await (service as any).from("users").select("id, email").in("id", userIds);
      const emailById = new Map(((users as any[]) || []).map((u) => [u.id, u.email]));
      for (const m of (maps as any[]) || []) {
        const email = emailById.get(m.user_id);
        if (email) emailsByClient.get(m.client_link_id)?.add(String(email));
      }
    }
  }

  const proposals: ClientMatchProposal[] = await mapPool(rows, 5, (r) =>
    proposeStripeMatch({
      clientLinkId: r.id,
      clientName: r.client_name || "",
      emails: Array.from(emailsByClient.get(r.id) || []),
    })
  );

  const summary = {
    unlinked: rows.length,
    recommended: proposals.filter((p) => p.recommended).length,
    needsReview: proposals.filter((p) => p.best && !p.recommended).length,
    unmatched: proposals.filter((p) => !p.best).length,
  };

  // Recommended first, then has-a-guess, then unmatched.
  proposals.sort((a, b) =>
    (b.recommended ? 2 : b.best ? 1 : 0) - (a.recommended ? 2 : a.best ? 1 : 0)
  );

  return NextResponse.json({ configured: true, proposals, summary });
}

/**
 * POST /api/admin/billing/backfill-stripe — APPLY approved links.
 * Body: { links: [{ clientLinkId, stripeCustomerId }] }
 * Each customer id is validated against Stripe before it's saved.
 */
export async function POST(request: Request) {
  const auth = await requireSenior();
  if ("error" in auth) return auth.error;
  const { user, service } = auth;

  const body = await request.json().catch(() => ({} as any));
  const links: { clientLinkId: string; stripeCustomerId: string }[] = Array.isArray(body.links)
    ? body.links
    : [];
  if (links.length === 0) {
    return NextResponse.json({ error: "No links to apply" }, { status: 400 });
  }

  const applied: { clientLinkId: string; stripeCustomerId: string }[] = [];
  const failed: { clientLinkId: string; reason: string }[] = [];

  for (const link of links) {
    const cusId = (link.stripeCustomerId || "").trim();
    const clId = (link.clientLinkId || "").trim();
    if (!clId || !/^cus_[A-Za-z0-9]+$/.test(cusId)) {
      failed.push({ clientLinkId: clId, reason: "Invalid client or customer id" });
      continue;
    }
    // Validate the customer exists (and isn't deleted) before linking.
    let valid = false;
    try {
      valid = !!(await getStripeCustomer(cusId));
    } catch (e: any) {
      failed.push({ clientLinkId: clId, reason: `Stripe check failed: ${e?.message || "error"}` });
      continue;
    }
    if (!valid) {
      failed.push({ clientLinkId: clId, reason: "Stripe customer not found / deleted" });
      continue;
    }
    const { error } = await service
      .from("client_links")
      .update({ stripe_customer_id: cusId } as any)
      .eq("id", clId);
    if (error) failed.push({ clientLinkId: clId, reason: error.message });
    else applied.push({ clientLinkId: clId, stripeCustomerId: cusId });
  }

  if (applied.length > 0) {
    await service.from("audit_log").insert({
      event_type: "billing_stripe_backfill",
      user_id: user.id,
      request_payload: { applied_count: applied.length, failed_count: failed.length, applied } as any,
    });
  }

  return NextResponse.json({ ok: true, appliedCount: applied.length, failedCount: failed.length, applied, failed });
}
