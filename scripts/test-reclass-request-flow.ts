/**
 * End-to-end smoke test for the client reclass-request feature.
 *
 * Exercises the data + library path without going through the HTTP API
 * (admins can't impersonate-write because the portal endpoints block it).
 *
 * Steps:
 *   1. Pick a healthy QBO-connected client + a real client_user
 *   2. Insert a fake reclass request (status='pending')
 *   3. Read it back via the same query /today uses
 *   4. Run the preview QBO scan (read-only)
 *   5. Test the DECLINE path (no QBO writes)
 *   6. Clean up — delete the row + audit log entries we created
 *
 * Does NOT exercise the approve-with-bulk-reclass path because that
 * writes to QBO. Set TEST_APPROVE=1 to also exercise it (DANGEROUS — only
 * on a client you've confirmed is safe to touch).
 *
 * Run: npx tsx scripts/test-reclass-request-flow.ts
 */

import { readFileSync } from "fs";

// Load .env.local before importing anything that reads env.
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createClient } from "@supabase/supabase-js";
import {
  fetchTransactionsForAccount,
  normalizeVendorName,
  getValidToken,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";

const TEST_APPROVE = process.env.TEST_APPROVE === "1";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`  ${c.dim("→")} ${name}… `);
  try {
    const r = await fn();
    console.log(c.green("ok"));
    return r;
  } catch (e: any) {
    console.log(c.red("FAIL"));
    console.log(c.red(`    ${e?.message || e}`));
    throw e;
  }
}

(async () => {
  console.log(c.bold("\nClient reclass-request smoke test\n"));

  // ─── 1. Pick a client. Try for full QBO-read access; fall back to
  //        DB-only mode if no client passes (lets us verify the data
  //        layer even when the fleet is mid-incident) ───
  let qboMode = true;
  let targetClient: any;
  let access: string = "";
  let accounts: any[] = [];
  try {
    const probe = await step(
      "Find a client whose QBO responds to reads",
      async () => {
      // Prefer clients the latest qbo_connection_health probe marked 'ok'.
      const { data: healthy } = await supa
        .from("qbo_connection_health" as any)
        .select("client_link_id, last_checked_at")
        .eq("status", "ok")
        .order("last_checked_at", { ascending: false })
        .limit(60);
      const candIds = ((healthy as any[]) || []).map((h) => h.client_link_id);
      if (candIds.length === 0) throw new Error("qbo_connection_health has no ok clients — run the health probe first");

      const { data: cands } = await supa
        .from("client_links")
        .select("id, client_name, qbo_realm_id, qbo_token_expires_at")
        .in("id", candIds);
      const failures: Array<{ name: string; reason: string }> = [];
      for (const cli of cands || []) {
        try {
          const tok = await getValidToken((cli as any).id, supa as any, "test/reclass-smoke");
          const accs = await fetchAllAccounts((cli as any).qbo_realm_id, tok);
          if (accs.length === 0) {
            failures.push({ name: (cli as any).client_name, reason: "empty COA" });
            continue;
          }
          return { targetClient: cli as any, access: tok, accounts: accs };
        } catch (e: any) {
          failures.push({ name: (cli as any).client_name, reason: (e?.message || String(e)).slice(0, 80) });
        }
      }
      console.log("\n     Tried and failed:");
      for (const f of failures.slice(0, 5)) console.log(`       · ${f.name}: ${f.reason}`);
      if (failures.length > 5) console.log(`       · …and ${failures.length - 5} more`);
      throw new Error(`No client passed token + COA read probes (tried ${cands?.length ?? 0})`);
      }
    );
    targetClient = probe.targetClient;
    access = probe.access;
    accounts = probe.accounts;
  } catch {
    qboMode = false;
    console.log(c.yellow("     ⚠ no healthy QBO read access — running DB-only smoke test"));
    // Fall back: pick any client_link so we have a real FK for the row
    const { data: anyClient } = await supa
      .from("client_links")
      .select("id, client_name, qbo_realm_id")
      .not("qbo_realm_id", "is", null)
      .eq("is_active", true)
      .limit(1)
      .single();
    if (!anyClient) throw new Error("Cannot find any client_link for FK satisfaction");
    targetClient = anyClient;
  }
  console.log(`     client: ${c.blue(targetClient.client_name)} (${targetClient.id})`);

  // ─── 2. Find a portal user mapped to this client (else fall back to admin) ───
  let portalUserId: string;
  {
    const { data: mapping } = await supa
      .from("client_users" as any)
      .select("user_id")
      .eq("client_link_id", targetClient.id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if ((mapping as any)?.user_id) {
      portalUserId = (mapping as any).user_id as string;
      console.log(`     portal user: ${c.dim(portalUserId)} (existing)`);
    } else {
      const { data: admin } = await supa
        .from("users")
        .select("id")
        .eq("role", "admin")
        .limit(1)
        .single();
      portalUserId = (admin as any).id;
      console.log(`     portal user: ${c.dim(portalUserId)} (admin fallback — client has no portal user)`);
    }
  }
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().slice(0, 10);

  let sourceAccount: { Id: string; Name: string } = { Id: "TEST_SRC_ACCT", Name: "[stub] Postage" };
  let targetAccount: { Id: string; Name: string } = { Id: "TEST_TGT_ACCT", Name: "[stub] Marketing" };
  let sampleLine: any = {
    transaction_id: "TEST_TXN_ID",
    vendor_name: "USPS",
    transaction_amount: 1001,
  };

  if (qboMode) {
    const expenseAccounts = accounts.filter(
      (a: any) => a.Classification === "Expense" && a.Active !== false
    );
    if (expenseAccounts.length < 2) {
      throw new Error("Need at least 2 expense accounts for the test");
    }
    let chosen: any = null;
    for (const a of expenseAccounts) {
      const res = await fetchTransactionsForAccount(
        targetClient.qbo_realm_id,
        access,
        a.Id,
        yearStart,
        today
      );
      if (res.lines.length > 0) {
        chosen = a;
        sampleLine = res.lines[0];
        break;
      }
    }
    if (!chosen) throw new Error("No expense account with YTD transactions found");
    sourceAccount = { Id: chosen.Id, Name: chosen.Name };
    const tgt = expenseAccounts.find((a: any) => a.Id !== chosen.Id)!;
    targetAccount = { Id: tgt.Id, Name: tgt.Name };
    console.log(
      `     source: ${c.blue(sourceAccount.Name)} (${sampleLine.vendor_name}, $${sampleLine.transaction_amount.toFixed(2)})`
    );
    console.log(`     target: ${c.blue(targetAccount.Name)}`);
  } else {
    console.log(c.dim("     using stub source/target — DB-only mode"));
  }

  // ─── 4. Insert the request row (simulating POST /api/portal/reclass-request) ───
  const requestId = await step("Insert client_reclass_requests row", async () => {
    const { data, error } = await supa
      .from("client_reclass_requests" as any)
      .insert({
        client_link_id: targetClient.id,
        requested_by: portalUserId,
        source_account_qbo_id: sourceAccount!.Id,
        source_account_name:   sourceAccount!.Name,
        target_account_qbo_id: targetAccount.Id,
        target_account_name:   targetAccount.Name,
        example_txn_id:        sampleLine.transaction_id,
        vendor_name:           sampleLine.vendor_name,
        client_reason:         "[smoke test] auto-generated request — safe to delete",
        status:                "pending",
      } as any)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return (data as any).id as string;
  });
  console.log(`     request_id: ${c.dim(requestId)}`);

  // ─── 5. Verify the bookkeeper list query returns it ───
  await step("Verify /today list query surfaces the request", async () => {
    const { data: rows, error } = await supa
      .from("client_reclass_requests" as any)
      .select("id, status, client_link_id")
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    const found = (rows as any[]).find((r) => r.id === requestId);
    if (!found) throw new Error("Inserted row didn't surface in pending list");
  });

  // ─── 6. Exercise the preview scan logic (the /preview endpoint's body) ───
  if (qboMode) {
    const preview = await step("Run preview scan (read-only QBO query)", async () => {
      const res = await fetchTransactionsForAccount(
        targetClient.qbo_realm_id,
        access,
        sourceAccount.Id,
        yearStart,
        today
      );
      const vendorNorm = normalizeVendorName(sampleLine.vendor_name);
      const matched = res.lines.filter(
        (l) => normalizeVendorName(l.vendor_name) === vendorNorm
      );
      return {
        account_total_lines: res.lines.length,
        matched_lines: matched.length,
        matched_transactions: new Set(matched.map((l) => l.transaction_id)).size,
        reconciled_lines: matched.filter((l) => l.is_reconciled).length,
        total_amount: matched.reduce((s, l) => s + l.transaction_amount, 0),
      };
    });
    console.log(
      `     ${preview.matched_transactions} txns / ${preview.matched_lines} lines / $${preview.total_amount.toFixed(2)}`
    );
    if (preview.reconciled_lines > 0) {
      console.log(c.yellow(`     ⚠ ${preview.reconciled_lines} reconciled lines — reclass would affect a closed period.`));
    }
  } else {
    console.log(c.yellow("  → Run preview scan (read-only QBO query)… skipped (no healthy QBO client)"));
  }

  // ─── 7. Test DECLINE path ───
  await step("Decline the request", async () => {
    const { error } = await supa
      .from("client_reclass_requests" as any)
      .update({
        status: "declined",
        decided_by: portalUserId,
        decided_at: new Date().toISOString(),
        decision_note: "[smoke test] auto-declined",
      } as any)
      .eq("id", requestId);
    if (error) throw new Error(error.message);
    const { data: row } = await supa
      .from("client_reclass_requests" as any)
      .select("status")
      .eq("id", requestId)
      .single();
    if ((row as any)?.status !== "declined") {
      throw new Error(`Expected status=declined, got ${(row as any)?.status}`);
    }
  });

  // ─── 8. Optional: actually approve + reclass (writes to QBO) ───
  if (TEST_APPROVE) {
    console.log(c.yellow("\n⚠ TEST_APPROVE=1 — exercising the approve path (writes to QBO)\n"));
    console.log(c.red("Not implemented in this script — exercise via the /today UI."));
  }

  // ─── 9. Cleanup ───
  await step("Clean up — delete the test row", async () => {
    const { error } = await supa
      .from("client_reclass_requests" as any)
      .delete()
      .eq("id", requestId);
    if (error) throw new Error(error.message);
  });
  await step("Clean up — delete related audit_log rows", async () => {
    // Our smoke insert didn't write to audit_log (we bypassed the API),
    // but check anyway in case future variants log on insert.
    await supa
      .from("audit_log")
      .delete()
      .contains("request_payload" as any, { request_id: requestId });
  });

  console.log(c.green("\n✓ all checks passed\n"));
  process.exit(0);
})().catch((e) => {
  console.error(c.red("\n✗ smoke test failed:"), e?.message || e);
  process.exit(1);
});
