import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createJournalEntry, fetchAllAccounts, getValidToken, qboRateLimiter } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/clients/[id]/uncat-income/[scanId]/finalize
 *
 * Execute every item with a JE-creating resolution.
 *
 * Strategy:
 *   - One JE per (resolution, target, customer) group → cleaner audit trail.
 *   - All four QBO-writing resolutions follow the same pattern:
 *       Dr Uncategorized Income (removes the credit balance)
 *       Cr <target account>     (lands the money where it belongs)
 *   - apply_to_invoice additionally attaches the customer's Entity ref to
 *     the A/R credit line so QBO applies it correctly.
 *   - ask_client / manual_investigation → no QBO write, just mark resolved.
 */

const QBO_WRITING_RESOLUTIONS = new Set([
  "apply_to_invoice",
  "customer_deposits",
  "write_off",
  "move_to_revenue",
]);

const NO_QBO_RESOLUTIONS = new Set([
  "ask_client",
  "manual_investigation",
]);

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: scan } = await service
    .from("uncat_income_scans" as any)
    .select("*")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });

  const { data: items } = await service
    .from("uncat_income_items" as any)
    .select("*")
    .eq("scan_id", scanId)
    .neq("resolution", "pending")
    .neq("resolution", "executed")
    .neq("resolution", "failed")
    .neq("resolution", "skipped");
  const queue = (items as any[]) || [];

  if (queue.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No resolved items to execute.",
      executed: 0,
      failed: 0,
    });
  }

  let accessToken: string;
  let allAccounts;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return NextResponse.json(
      { error: `QBO bootstrap failed: ${err?.message || String(err)}` },
      { status: 500 }
    );
  }
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));
  const uncatAccountId = (scan as any).uncat_account_qbo_id as string;
  const uncatAccount = accountById.get(uncatAccountId);
  const uncatAccountName = uncatAccount?.Name || (scan as any).uncat_account_name || "Uncategorized Income";

  await service
    .from("uncat_income_scans" as any)
    .update({ status: "finalizing" } as any)
    .eq("id", scanId);

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const today = new Date().toISOString().slice(0, 10);

  // Group QBO-writing items by (resolution, target_account_id OR target_invoice_id, customer)
  const groups = new Map<string, any[]>();
  const noTargetItems: any[] = [];

  // Pre-fetch invoice customer info for apply_to_invoice rows
  // (we need to look up the customer attached to each target invoice)
  const invoiceIdsNeeded = new Set<string>();
  for (const item of queue) {
    if (item.resolution === "apply_to_invoice" && item.target_invoice_qbo_id) {
      invoiceIdsNeeded.add(item.target_invoice_qbo_id);
    }
  }
  const invoiceById = new Map<string, any>();
  if (invoiceIdsNeeded.size > 0) {
    const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
    const ids = Array.from(invoiceIdsNeeded);
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const inClause = batch.map((id) => `'${id}'`).join(",");
      const query = encodeURIComponent(`SELECT * FROM Invoice WHERE Id IN (${inClause})`);
      try {
        await qboRateLimiter.throttle((client as any).qbo_realm_id);
        const res = await fetch(
          `${QBO_BASE}/${(client as any).qbo_realm_id}/query?query=${query}`,
          { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
        );
        if (res.ok) {
          const data: any = await res.json();
          const rows: any[] = data?.QueryResponse?.Invoice || [];
          for (const inv of rows) invoiceById.set(String(inv.Id), inv);
        }
      } catch {
        // best-effort; missing invoices will fail their items with a clear message
      }
    }
  }

  for (const item of queue) {
    if (NO_QBO_RESOLUTIONS.has(item.resolution)) continue;
    if (!QBO_WRITING_RESOLUTIONS.has(item.resolution)) continue;

    // apply_to_invoice: target identity is the invoice itself
    // others: target identity is the account
    let targetKey: string;
    if (item.resolution === "apply_to_invoice") {
      if (!item.target_invoice_qbo_id) {
        noTargetItems.push(item);
        continue;
      }
      targetKey = `apply_to_invoice|${item.target_invoice_qbo_id}`;
    } else {
      if (!item.target_account_qbo_id) {
        noTargetItems.push(item);
        continue;
      }
      const customer = item.target_customer_qbo_id || item.customer_qbo_id || "_none_";
      targetKey = `${item.resolution}|${item.target_account_qbo_id}|${customer}`;
    }

    if (!groups.has(targetKey)) groups.set(targetKey, []);
    groups.get(targetKey)!.push(item);
  }

  let executed = 0;
  let failed = 0;
  const results: any[] = [];

  // 1) No-op resolutions
  for (const item of queue) {
    if (NO_QBO_RESOLUTIONS.has(item.resolution)) {
      await service
        .from("uncat_income_items" as any)
        .update({
          resolution: "executed",
          resolved_at: new Date().toISOString(),
        } as any)
        .eq("id", item.id);
      executed++;
      results.push({ id: item.id, status: "ok", type: "no-op" });
    }
  }

  // 2) Missing target items
  for (const item of noTargetItems) {
    await service
      .from("uncat_income_items" as any)
      .update({
        resolution: "failed",
        execution_error: "No target selected — pick an invoice or account before finalizing.",
      } as any)
      .eq("id", item.id);
    failed++;
    results.push({ id: item.id, status: "failed", error: "missing target" });
  }

  // 3) Post one JE per group
  for (const [key, groupItems] of groups) {
    const sample = groupItems[0];
    const total =
      Math.round(
        groupItems.reduce((s, it) => s + Number(it.amount || 0), 0) * 100
      ) / 100;

    if (total <= 0) {
      for (const it of groupItems) {
        await service
          .from("uncat_income_items" as any)
          .update({
            resolution: "failed",
            execution_error: "Zero or negative total — skipped to avoid invalid JE.",
          } as any)
          .eq("id", it.id);
        failed++;
      }
      continue;
    }

    try {
      let creditAccountId: string;
      let creditAccountName: string;
      let creditCustomerEntity: any = undefined;
      let resolutionLabel: string;

      if (sample.resolution === "apply_to_invoice") {
        const invoice = invoiceById.get(sample.target_invoice_qbo_id);
        if (!invoice) {
          throw new Error(
            `Target invoice ${sample.target_invoice_qbo_id} not found in QBO (may have been deleted).`
          );
        }
        // Find the A/R account on the invoice
        const arRef = invoice.ARAccountRef;
        if (!arRef?.value) {
          throw new Error(`Target invoice ${sample.target_invoice_qbo_id} has no A/R account ref.`);
        }
        const customerRef = invoice.CustomerRef;
        if (!customerRef?.value) {
          throw new Error(`Target invoice ${sample.target_invoice_qbo_id} has no customer ref.`);
        }
        creditAccountId = String(arRef.value);
        creditAccountName = String(arRef.name || "Accounts Receivable");
        creditCustomerEntity = {
          Type: "Customer",
          EntityRef: { value: customerRef.value, name: customerRef.name },
        };
        resolutionLabel = `Apply to invoice ${invoice.DocNumber || invoice.Id} (${customerRef.name || ""})`;
      } else {
        const target = accountById.get(sample.target_account_qbo_id);
        if (!target) {
          throw new Error(
            `Target account ${sample.target_account_qbo_id} not found in QBO.`
          );
        }
        if (target.Active === false) {
          throw new Error(
            `Target account "${target.Name}" is inactive — reactivate or pick another.`
          );
        }
        creditAccountId = target.Id;
        creditAccountName = target.Name;
        resolutionLabel = sample.resolution.replace(/_/g, " ");
      }

      // Build JE
      const debitLines = groupItems.map((it: any) => ({
        posting_type: "Debit" as const,
        amount: Math.round(Number(it.amount) * 100) / 100,
        account_id: uncatAccountId,
        account_name: uncatAccountName,
        description: `Clear ${it.qbo_txn_type} ${it.qbo_txn_id} (${it.txn_date}, ${it.description || "no description"})`,
      }));
      const creditLines = [
        {
          posting_type: "Credit" as const,
          amount: total,
          account_id: creditAccountId,
          account_name: creditAccountName,
          description: `${resolutionLabel} — ${groupItems.length} deposit${groupItems.length === 1 ? "" : "s"} from Uncategorized Income`,
        },
      ];

      // Build JE body manually for apply_to_invoice (needs Entity on the
      // A/R credit line — createJournalEntry helper doesn't expose Entity)
      let createdJeId: string;
      if (creditCustomerEntity) {
        await qboRateLimiter.throttle((client as any).qbo_realm_id);
        const body: any = {
          TxnDate: today,
          PrivateNote: `Ironbooks Uncat Income Recovery (by ${bookkeeperName}) — ${resolutionLabel}`,
          Line: [
            ...debitLines.map((l) => ({
              DetailType: "JournalEntryLineDetail",
              Amount: Number(l.amount.toFixed(2)),
              Description: l.description,
              JournalEntryLineDetail: {
                PostingType: l.posting_type,
                AccountRef: { value: l.account_id, name: l.account_name },
              },
            })),
            {
              DetailType: "JournalEntryLineDetail",
              Amount: Number(total.toFixed(2)),
              Description: creditLines[0].description,
              JournalEntryLineDetail: {
                PostingType: "Credit",
                AccountRef: { value: creditAccountId, name: creditAccountName },
                Entity: creditCustomerEntity,
              },
            },
          ],
        };
        const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
        const res = await fetch(
          `${QBO_BASE}/${(client as any).qbo_realm_id}/journalentry?minorversion=70`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`QBO JE create failed ${res.status}: ${errBody}`);
        }
        const data: any = await res.json();
        createdJeId = data?.JournalEntry?.Id;
        if (!createdJeId) throw new Error("QBO returned no JE Id");
      } else {
        const created = await createJournalEntry((client as any).qbo_realm_id, accessToken, {
          txn_date: today,
          private_note: `Ironbooks Uncat Income Recovery (by ${bookkeeperName}) — ${resolutionLabel}`,
          lines: [...debitLines, ...creditLines],
        });
        createdJeId = created.Id;
      }

      for (const it of groupItems) {
        await service
          .from("uncat_income_items" as any)
          .update({
            resolution: "executed",
            resolution_je_id: createdJeId,
            resolved_at: new Date().toISOString(),
          } as any)
          .eq("id", it.id);
        executed++;
      }
      results.push({
        group: key,
        je_id: createdJeId,
        status: "ok",
        items: groupItems.length,
        total,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      for (const it of groupItems) {
        await service
          .from("uncat_income_items" as any)
          .update({ resolution: "failed", execution_error: msg } as any)
          .eq("id", it.id);
        failed++;
      }
      results.push({ group: key, status: "failed", error: msg, items: groupItems.length });
    }
  }

  const finalStatus = failed > 0 && executed === 0 ? "failed" : "finalized";
  await service
    .from("uncat_income_scans" as any)
    .update({
      status: finalStatus,
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
      finalize_results: { executed, failed, results },
    } as any)
    .eq("id", scanId);

  return NextResponse.json({ ok: true, executed, failed, results });
}
