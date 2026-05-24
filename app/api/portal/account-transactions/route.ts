import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { fetchAccountTransactions } from "@/lib/qbo-balance-sheet";

/**
 * GET /api/portal/account-transactions?account_id=X&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns the QBO transactions that hit a given account in a date range —
 * powers the P&L drill-down ("what's in 'Subcontractors: $22,400'?").
 *
 * Auth: only this client's portal user can hit this; the QBO token + realm
 * come from resolvePortalContext, NOT from any request parameter. So even
 * if a client manipulates the URL to a different account_id, they only
 * ever see THEIR books' transactions for that account.
 *
 * Includes a soft sanity check: limit results to 500 to keep the modal
 * snappy. If a line genuinely has more, the UI shows a "+ N more — ask
 * your bookkeeper for a full export" footer.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_TRANSACTIONS = 500;

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("account_id");
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!accountId) return NextResponse.json({ error: "account_id required" }, { status: 400 });
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const all = await fetchAccountTransactions(
      ctx.qboRealmId,
      ctx.accessToken,
      accountId,
      start,
      end
    );
    // Sort newest first for the drill-down view
    all.sort((a, b) => b.date.localeCompare(a.date));

    const truncated = all.length > MAX_TRANSACTIONS;
    const transactions = truncated ? all.slice(0, MAX_TRANSACTIONS) : all;
    const total = transactions.reduce((s, t) => s + (t.delta || t.amount || 0), 0);

    return NextResponse.json({
      ok: true,
      transactions,
      total_count: all.length,
      total_amount: total,
      truncated,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Couldn't load transactions: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
