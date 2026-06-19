import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { fetchProfitAndLossByMonth } from "@/lib/qbo-pl-by-month";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/clients/[id]/pl-by-month?months=3
 *
 * Month-by-month P&L for the client — one column per calendar month over the
 * last N months (default 3, incl. the current month-to-date) plus QBO's Total
 * column. Drives the side-by-side comparative view on the P&L tab.
 *
 * Auth: any internal staff (admin/lead/bookkeeper/viewer) — same as the
 * client profile page they're viewing it from.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper", "viewer"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client has no QuickBooks connection" }, { status: 400 });
  }

  const monthsParam = parseInt(new URL(request.url).searchParams.get("months") || "3", 10);
  const months = Math.min(Math.max(Number.isFinite(monthsParam) ? monthsParam : 3, 1), 12);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const startD = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const start = `${startD.getFullYear()}-${pad(startD.getMonth() + 1)}-01`;
  const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const data = await fetchProfitAndLossByMonth((client as any).qbo_realm_id, accessToken, start, end);
    return NextResponse.json({ ...data, start, end });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
