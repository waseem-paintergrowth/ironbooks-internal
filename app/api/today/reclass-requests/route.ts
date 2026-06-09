import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * GET /api/today/reclass-requests
 *
 * Bookkeeper-side list of pending client reclass requests. Mirrors the
 * portal_transaction_flags fetch in /today/page.tsx — bookkeepers see
 * requests for their assigned clients only; admins + leads see everything.
 *
 * Query params:
 *   status — defaults to "pending,approved" (pre-application states).
 *            Pass "all" to include applied/declined/failed in history view.
 *
 * Response: { ok, requests: [{ ...row, client_name, requester_name, requester_email }] }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const isSenior = role === "admin" || role === "lead";

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const statuses = statusParam === "all"
    ? null
    : (statusParam || "pending").split(",").map((s) => s.trim()).filter(Boolean);

  let query = service
    .from("client_reclass_requests" as any)
    .select(
      "id, client_link_id, requested_by, requested_at, " +
      "source_account_qbo_id, source_account_name, target_account_qbo_id, target_account_name, " +
      "example_txn_id, vendor_name, client_reason, status, " +
      "decided_by, decided_at, decision_note, applied_txn_count, applied_at, bank_rule_created"
    )
    .order("requested_at", { ascending: false });

  if (statuses) query = query.in("status", statuses);

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const raw = (rows as any[]) || [];

  // Bookkeepers only see their own clients' requests.
  let filtered = raw;
  if (!isSenior && raw.length > 0) {
    const { data: ownedClients } = await service
      .from("client_links")
      .select("id")
      .eq("assigned_bookkeeper_id", user.id);
    const ownedIds = new Set(((ownedClients as any[]) || []).map((c) => c.id));
    filtered = raw.filter((r) => ownedIds.has(r.client_link_id));
  }

  if (filtered.length === 0) return NextResponse.json({ ok: true, requests: [] });

  // Enrich with client + requester names so the UI doesn't have to re-fetch.
  const clientIds = Array.from(new Set(filtered.map((r) => r.client_link_id)));
  const requesterIds = Array.from(new Set(filtered.map((r) => r.requested_by).filter(Boolean)));
  const [{ data: cn }, { data: un }] = await Promise.all([
    clientIds.length > 0
      ? service.from("client_links").select("id, client_name").in("id", clientIds)
      : Promise.resolve({ data: [] }),
    requesterIds.length > 0
      ? service.from("users").select("id, full_name, email").in("id", requesterIds)
      : Promise.resolve({ data: [] }),
  ]);
  const clientNameById = new Map(((cn as any[]) || []).map((c) => [c.id, c.client_name]));
  const userById = new Map(
    ((un as any[]) || []).map((u) => [u.id, { full_name: u.full_name, email: u.email }])
  );

  const enriched = filtered.map((r) => ({
    ...r,
    client_name: clientNameById.get(r.client_link_id) || "(unknown client)",
    requester_name: userById.get(r.requested_by)?.full_name || "",
    requester_email: userById.get(r.requested_by)?.email || "",
  }));

  return NextResponse.json({ ok: true, requests: enriched });
}
