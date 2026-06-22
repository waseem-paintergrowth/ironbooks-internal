/**
 * Statement intake — when a client (or bookkeeper) uploads a bank/CC/loan
 * statement, read it with Claude, identify the account + period, match it to a
 * QBO account, rename it "<Account> – Mon YYYY", and file a client_statements
 * row so it shows in the client's Statements section (and, later, the BS
 * cleanup view).
 *
 * Reuses the existing extraction (lib/cleanup-system/statement-analysis) so the
 * AI logic stays in one place — this just runs it for a single uploaded file
 * and persists the result instead of writing recon-job gaps.
 */
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";
import { extractStatements, reconCandidates } from "@/lib/cleanup-system/statement-analysis";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Parse "YYYY-MM-DD" → {month 1-12, year}. Tolerant of nulls/garbage. */
function parsePeriod(endDate: string | null): { month: number | null; year: number | null } {
  if (!endDate) return { month: null, year: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate.trim());
  if (!m) return { month: null, year: null };
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return { month: null, year };
  return { month, year };
}

/** "<Account> – Mon YYYY" — falls back gracefully when pieces are missing. */
function buildDisplayName(
  account: string | null,
  month: number | null,
  year: number | null,
  fallback: string
): string {
  const acct = (account || "").trim();
  const period = month && year ? `${MONTHS[month - 1]} ${year}` : year ? String(year) : "";
  if (acct && period) return `${acct} – ${period}`;
  if (acct) return acct;
  if (period) return `Statement – ${period}`;
  return fallback || "Statement";
}

export interface IntakeResult {
  ok: boolean;
  id?: string;
  display_name?: string;
  matched_account_name?: string | null;
  match_confidence?: string | null;
  period_month?: number | null;
  period_year?: number | null;
  error?: string;
}

/**
 * Process ONE uploaded statement already sitting at `storagePath` in the
 * client-uploads bucket. Inserts a client_statements row and returns it.
 *
 * QBO matching is best-effort: if the client has no QBO connection (or it
 * fails), the statement is still filed with whatever Claude read off the page
 * (account label + period), just without a QBO-account match.
 */
export async function intakeStatement(
  service: any,
  opts: {
    clientLinkId: string;
    storagePath: string;
    originalName: string;
    uploadedBy?: string | null;
    uploadedVia?: "portal" | "bookkeeper";
  }
): Promise<IntakeResult> {
  const { clientLinkId, storagePath, originalName } = opts;

  // 1. Pull the file bytes back out of storage as base64 for Claude.
  const dl = await service.storage.from(CLIENT_UPLOADS_BUCKET).download(storagePath);
  if (dl.error || !dl.data) {
    return { ok: false, error: "Could not read the uploaded file" };
  }
  const base64 = Buffer.from(await dl.data.arrayBuffer()).toString("base64");

  // 2. Build the QBO candidate list (best-effort).
  let accounts: any[] = [];
  try {
    const { data: client } = await service
      .from("client_links")
      .select("qbo_realm_id, qbo_refresh_token")
      .eq("id", clientLinkId)
      .single();
    if (client?.qbo_realm_id && client?.qbo_refresh_token) {
      const token = await getValidToken(clientLinkId, service);
      accounts = await fetchAllAccounts(client.qbo_realm_id, token);
    }
  } catch (e) {
    // No QBO / token trouble — fall through with an empty candidate list.
    accounts = [];
  }
  const candidates = reconCandidates(accounts);

  // 3. Extract + match with the shared statement reader.
  let ex;
  try {
    [ex] = await extractStatements([{ filename: originalName, base64 }], candidates);
  } catch (e: any) {
    return { ok: false, error: e?.message || "Statement reading failed" };
  }
  if (!ex) return { ok: false, error: "Statement reading returned nothing" };

  const matchedName =
    accounts.find((a) => String(a.Id) === ex!.matched_qbo_account_id)?.Name ||
    null;
  const { month, year } = parsePeriod(ex.statement_end_date);
  const accountForName = matchedName || ex.account_label || ex.institution;
  const displayName = buildDisplayName(accountForName, month, year, originalName);
  const status = ex.matched_qbo_account_id ? "processed" : "unmatched";

  // 4. File it.
  const { data: row, error } = await service
    .from("client_statements")
    .insert({
      client_link_id: clientLinkId,
      storage_path: storagePath,
      original_name: originalName,
      display_name: displayName,
      institution: ex.institution,
      account_label: ex.account_label,
      last4: ex.last4,
      account_kind: ex.account_kind,
      matched_qbo_account_id: ex.matched_qbo_account_id,
      matched_account_name: matchedName,
      match_confidence: ex.match_confidence,
      period_month: month,
      period_year: year,
      statement_end_date: ex.statement_end_date,
      ending_balance: ex.ending_balance,
      status,
      notes: ex.notes,
      uploaded_by: opts.uploadedBy ?? null,
      uploaded_via: opts.uploadedVia ?? "portal",
    })
    .select("id, display_name, matched_account_name, match_confidence, period_month, period_year")
    .single();

  if (error || !row) {
    return { ok: false, error: error?.message || "Could not file the statement" };
  }

  return {
    ok: true,
    id: row.id,
    display_name: row.display_name,
    matched_account_name: row.matched_account_name,
    match_confidence: row.match_confidence,
    period_month: row.period_month,
    period_year: row.period_year,
  };
}
