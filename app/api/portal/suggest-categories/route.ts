import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { fetchAllAccounts } from "@/lib/qbo";

/**
 * POST /api/portal/suggest-categories
 *
 * Used by the Flag modal on /portal/profit-loss to offer 3-5 AI-picked
 * alternative QBO accounts for a transaction. The client picks one
 * (turning the flag into a reclass request) or selects "None of these"
 * (keeping it as a plain flag for the bookkeeper to triage).
 *
 * Body:
 *   {
 *     vendor_name?:     string,   // payee
 *     memo?:            string,   // line description / private note
 *     amount?:          number,
 *     current_account_id:    string,  // required — the account it's in now
 *     current_account_name?: string,
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     suggestions: [
 *       { account_id, account_name, fully_qualified_name, reason },
 *       ...
 *     ]
 *   }
 *
 * Falls back to {ok:true, suggestions:[]} on any AI/parse failure — the
 * client UI treats an empty list as "no AI suggestions, just show 'None'".
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = "claude-opus-4-7";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
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

  const body = await request.json().catch(() => ({} as any));
  const currentAccountId = String(body.current_account_id || "");
  if (!currentAccountId) {
    return NextResponse.json(
      { error: "current_account_id is required" },
      { status: 400 }
    );
  }
  const vendor = body.vendor_name ? String(body.vendor_name) : "";
  const memo = body.memo ? String(body.memo) : "";
  const amount = typeof body.amount === "number" ? body.amount : null;
  const currentAccountName = body.current_account_name
    ? String(body.current_account_name)
    : "";

  // Pull the live chart of accounts so the model only suggests real
  // accounts the client has. Filter to Revenue + Expense — those are the
  // only buckets a P&L reclass can target.
  let accounts;
  try {
    accounts = await fetchAllAccounts(ctx.qboRealmId, ctx.accessToken);
  } catch {
    return NextResponse.json({ ok: true, suggestions: [] });
  }
  const candidates = accounts
    .filter((a) => a.Active !== false)
    .filter((a) => a.Classification === "Revenue" || a.Classification === "Expense")
    .filter((a) => a.Id !== currentAccountId);

  // Cap the COA we send to Claude — most clients have <100 P&L accounts,
  // but a few have 500+. Keep the prompt focused.
  const trimmed = candidates.slice(0, 200).map((a) => ({
    id: a.Id,
    fully_qualified_name: a.FullyQualifiedName,
    type: a.AccountType,
    sub_type: a.AccountSubType,
  }));

  // Build prompt. We ask for STRICT json — no preamble — so a single
  // JSON.parse works. The model's been reliable at this with opus.
  const userPrompt = [
    `A bookkeeping client thinks the QuickBooks account on this transaction might be wrong.`,
    ``,
    `Transaction:`,
    `- Vendor: ${vendor || "(unknown)"}`,
    `- Memo: ${memo || "(none)"}`,
    `- Amount: ${amount != null ? `$${amount.toFixed(2)}` : "(unknown)"}`,
    `- Currently in: ${currentAccountName || "(unknown)"} (id ${currentAccountId})`,
    ``,
    `Pick up to 5 BETTER candidate accounts from this client's chart of accounts. Only return accounts that genuinely fit the transaction — if nothing fits, return an empty array. Do NOT include the current account.`,
    ``,
    `Available accounts (JSON):`,
    JSON.stringify(trimmed),
    ``,
    `Respond with ONLY a JSON object in this exact shape, no prose:`,
    `{ "suggestions": [ { "account_id": "<id>", "reason": "<one short sentence>" } ] }`,
    `Order by confidence (most likely first). 0-5 items.`,
  ].join("\n");

  let suggestionsJson: { suggestions: Array<{ account_id: string; reason: string }> };
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    // Strip code fences if the model wraps despite instructions.
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    suggestionsJson = JSON.parse(cleaned);
  } catch {
    return NextResponse.json({ ok: true, suggestions: [] });
  }

  // Resolve suggestion ids back to full account records (validate they
  // exist in candidates — if Claude hallucinates an id we drop it).
  const byId = new Map(candidates.map((a) => [a.Id, a]));
  const resolved = (suggestionsJson.suggestions || [])
    .filter((s) => s.account_id && byId.has(s.account_id))
    .slice(0, 5)
    .map((s) => {
      const a = byId.get(s.account_id)!;
      return {
        account_id: a.Id,
        account_name: a.Name,
        fully_qualified_name: a.FullyQualifiedName,
        account_type: a.AccountType,
        account_sub_type: a.AccountSubType,
        reason: String(s.reason || "").slice(0, 200),
      };
    });

  return NextResponse.json({ ok: true, suggestions: resolved });
}
