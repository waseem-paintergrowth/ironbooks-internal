import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { fetchAllAccounts } from "@/lib/qbo";

/**
 * GET /api/portal/qbo-accounts
 *
 * Returns the active QBO chart of accounts for the portal user's client,
 * trimmed to fields the reclass-request modal needs. Used to populate the
 * "move this to which category?" autocomplete.
 *
 * Default returns Income + Expense accounts (the universe a P&L
 * reclassification can target). Pass ?include=all to get every active
 * account (used by manager-side flows that may need balance sheet
 * accounts too).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     accounts: [
 *       { id, name, fully_qualified_name, account_type, account_sub_type, classification },
 *       ...
 *     ]
 *   }
 *
 * No caching at the API layer — getValidToken handles QBO auth and the
 * underlying QBO API request is cheap (~1 round trip). Client-side
 * caching for the modal session lives in the component.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  const url = new URL(request.url);
  const includeAll = url.searchParams.get("include") === "all";

  let accounts;
  try {
    accounts = await fetchAllAccounts(ctx.qboRealmId, ctx.accessToken);
  } catch (e) {
    return NextResponse.json(
      { error: `Couldn't fetch chart of accounts: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const filtered = accounts
    .filter((a) => a.Active !== false)
    .filter((a) =>
      includeAll
        ? true
        : a.Classification === "Revenue" || a.Classification === "Expense"
    )
    .map((a) => ({
      id: a.Id,
      name: a.Name,
      fully_qualified_name: a.FullyQualifiedName,
      account_type: a.AccountType,
      account_sub_type: a.AccountSubType,
      classification: a.Classification,
    }))
    // Sort by fully-qualified name so sub-accounts cluster under parents.
    .sort((a, b) =>
      a.fully_qualified_name.localeCompare(b.fully_qualified_name)
    );

  return NextResponse.json({ ok: true, accounts: filtered });
}
