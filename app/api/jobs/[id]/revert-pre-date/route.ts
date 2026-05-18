import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse, after } from "next/server";
import { getValidToken, fetchAllAccounts, reactivateAccount } from "@/lib/qbo";
import {
  fetchTransactionsForAccount,
  reclassifyTransactionLines,
} from "@/lib/qbo-reclass";

/**
 * POST /api/jobs/[id]/revert-pre-date
 *
 * Reverses the merge stage of a COA cleanup job for transactions dated
 * BEFORE the given date. Used when a cleanup ran against an over-broad
 * date range (e.g. before Migration 17 added the bookkeeper-selected
 * date scope) and now we need to put closed-period transactions back
 * where they came from.
 *
 * Body:
 *   { before_date: "2026-01-01" }
 *
 * For each coa_actions row where action='merge' AND executed=true:
 *   1. Resolve the source account (action.qbo_account_id) — reactivate
 *      it if it was inactivated by the original merge.
 *   2. Resolve the target account by name (action.new_name → live QBO id).
 *   3. Pull every line on the target account BEFORE before_date.
 *   4. Filter lines whose transaction PrivateNote contains the Ironbooks
 *      merge marker for THIS action ("Ironbooks merge: \"X\" → \"Y\"" or
 *      the partial-merge variant). Other transactions on target stay put.
 *   5. Reclassify each matching line back to the source account.
 *
 * Audit-log-rich so the bookkeeper can see what happened.
 */

export const maxDuration = 800;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const beforeDate: string | undefined = body.before_date;
  if (!beforeDate || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    return NextResponse.json(
      { error: "before_date (YYYY-MM-DD) is required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Load the job + client so we know which QBO to talk to.
  const { data: job } = await service
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const clientLink = (job as any).client_links;
  if (!clientLink) return NextResponse.json({ error: "Client link missing" }, { status: 400 });

  // Load every completed merge action — those are the ones that actually
  // moved transactions. Renames, creates, deletes don't need reverting.
  const { data: mergeActions } = await service
    .from("coa_actions")
    .select("id, qbo_account_id, current_name, new_name, executed, result_data")
    .eq("job_id", jobId)
    .eq("action", "merge")
    .eq("executed", true);

  if (!mergeActions || mergeActions.length === 0) {
    return NextResponse.json({
      ok: true,
      reverted_actions: 0,
      reverted_lines: 0,
      message: "No completed merges to revert.",
    });
  }

  // Kick off the actual revert work in the background — same `after()`
  // pattern as the main executor. Returns 202-style immediately.
  after(async () => {
    const svc = createServiceSupabase();
    try {
      await runRevert(jobId, beforeDate, user.id, mergeActions, clientLink, svc);
    } catch (err: any) {
      console.error(`[revert-pre-date] Job ${jobId} failed:`, err);
      await svc.from("audit_log").insert({
        job_id: jobId,
        user_id: user.id,
        event_type: "revert_failed",
        request_payload: { error: err.message, before_date: beforeDate } as any,
      });
    }
  });

  return NextResponse.json({
    started: true,
    job_id: jobId,
    before_date: beforeDate,
    merge_actions_to_inspect: mergeActions.length,
  });
}

async function runRevert(
  jobId: string,
  beforeDate: string,
  bookkeeperId: string,
  mergeActions: any[],
  clientLink: any,
  service: ReturnType<typeof createServiceSupabase>
) {
  const accessToken = await getValidToken(clientLink.id, service as any);
  const realmId = clientLink.qbo_realm_id;

  await service.from("audit_log").insert({
    job_id: jobId,
    user_id: bookkeeperId,
    event_type: "revert_start",
    request_payload: {
      message: `Reverting completed merges for transactions before ${beforeDate}`,
      before_date: beforeDate,
      merge_actions: mergeActions.length,
    } as any,
  });

  // Resolve live QBO accounts once. We need:
  //   - source account id → SyncToken + current Active state (might be inactive)
  //   - target account by name → live id
  // Use includeInactive so we can see the now-inactive sources.
  const allAccounts = await fetchAllAccounts(realmId, accessToken);
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));
  const accountByNameInsensitive = new Map<string, typeof allAccounts[number]>();
  for (const a of allAccounts) {
    if (a.Active !== false && a.Name) {
      accountByNameInsensitive.set(a.Name.trim().toLowerCase(), a);
    }
  }

  let totalLinesReverted = 0;
  let actionsReverted = 0;
  let actionsSkipped = 0;
  const errors: string[] = [];

  for (const action of mergeActions) {
    const sourceId: string = action.qbo_account_id;
    const targetName: string = String(action.new_name || "");
    const sourceLabel: string = String(action.current_name || sourceId);

    // Both possible merge marker strings (full and partial). We append the
    // start of each so we tolerate any future suffix changes.
    const fullMarker = `Ironbooks merge: "${action.current_name}" → "${action.new_name}"`;
    const partialMarker = `Ironbooks partial merge (open period): "${action.current_name}" → "${action.new_name}"`;

    try {
      const targetAccount = accountByNameInsensitive.get(targetName.trim().toLowerCase());
      if (!targetAccount) {
        actionsSkipped++;
        errors.push(`${sourceLabel}: target "${targetName}" not found in QBO`);
        await service.from("audit_log").insert({
          job_id: jobId,
          user_id: bookkeeperId,
          event_type: "revert_skipped",
          request_payload: {
            source: sourceLabel,
            target: targetName,
            reason: "Target account not found",
          } as any,
        });
        continue;
      }

      // Pull lines on the target before the cutoff. fetchTransactionsForAccount
      // returns lines whose AccountRef = targetAccount.Id within the date range.
      const { lines } = await fetchTransactionsForAccount(
        realmId,
        accessToken,
        targetAccount.Id,
        "2000-01-01",
        beforeDate
      );

      // Filter to lines whose transaction memo identifies them as moved
      // by THIS specific merge.
      const linesToRevert = lines.filter((l) => {
        const memo = String(l.private_note || "");
        return memo.includes(fullMarker) || memo.includes(partialMarker);
      });

      if (linesToRevert.length === 0) {
        actionsSkipped++;
        await service.from("audit_log").insert({
          job_id: jobId,
          user_id: bookkeeperId,
          event_type: "revert_no_matches",
          request_payload: {
            source: sourceLabel,
            target: targetName,
            before_date: beforeDate,
            target_lines_scanned: lines.length,
            message: "No pre-date lines carrying this merge's audit memo.",
          } as any,
        });
        continue;
      }

      // Reactivate the source if it was inactivated by the full merge.
      // (Partial merges leave the source active.)
      let sourceAccount: any = accountById.get(sourceId);
      if (sourceAccount && sourceAccount.Active === false) {
        try {
          sourceAccount = await reactivateAccount(
            realmId,
            accessToken,
            sourceId,
            sourceAccount.SyncToken,
            sourceAccount
          );
          await service.from("audit_log").insert({
            job_id: jobId,
            user_id: bookkeeperId,
            event_type: "revert_reactivated_source",
            request_payload: {
              source: sourceLabel,
              source_id: sourceId,
            } as any,
          });
        } catch (e: any) {
          actionsSkipped++;
          errors.push(`${sourceLabel}: could not reactivate source: ${e.message}`);
          await service.from("audit_log").insert({
            job_id: jobId,
            user_id: bookkeeperId,
            event_type: "revert_reactivation_failed",
            request_payload: {
              source: sourceLabel,
              error: e.message,
            } as any,
          });
          continue;
        }
      }

      // Group the lines by transaction so we can write each transaction
      // once even when multiple of its lines moved.
      const linesByTx = new Map<string, typeof linesToRevert>();
      for (const line of linesToRevert) {
        if (!linesByTx.has(line.transaction_id)) linesByTx.set(line.transaction_id, []);
        linesByTx.get(line.transaction_id)!.push(line);
      }

      let linesRevertedForAction = 0;
      let lastHeartbeat = 0;
      for (const [, txLines] of linesByTx) {
        const txType = txLines[0].transaction_type;
        await reclassifyTransactionLines(realmId, accessToken, {
          txType,
          txId: txLines[0].transaction_id,
          lineUpdates: txLines.map((l) => ({
            line_id: l.line_id,
            new_account_id: sourceId,
            new_account_name: sourceLabel,
          })),
          auditMemo: `Ironbooks revert: pre-${beforeDate} lines back to "${sourceLabel}"`,
        });
        linesRevertedForAction += txLines.length;

        if (linesRevertedForAction - lastHeartbeat >= 50) {
          lastHeartbeat = linesRevertedForAction;
          await service.from("audit_log").insert({
            job_id: jobId,
            user_id: bookkeeperId,
            event_type: "revert_progress",
            request_payload: {
              source: sourceLabel,
              target: targetName,
              lines_done: linesRevertedForAction,
              lines_total: linesToRevert.length,
            } as any,
          });
        }
      }

      totalLinesReverted += linesRevertedForAction;
      actionsReverted++;
      await service.from("audit_log").insert({
        job_id: jobId,
        user_id: bookkeeperId,
        event_type: "revert_action_complete",
        request_payload: {
          source: sourceLabel,
          target: targetName,
          lines_reverted: linesRevertedForAction,
          before_date: beforeDate,
        } as any,
      });
    } catch (err: any) {
      actionsSkipped++;
      errors.push(`${sourceLabel}: ${err.message}`);
      await service.from("audit_log").insert({
        job_id: jobId,
        user_id: bookkeeperId,
        event_type: "revert_error",
        request_payload: {
          source: sourceLabel,
          error: err.message,
        } as any,
      });
    }
  }

  await service.from("audit_log").insert({
    job_id: jobId,
    user_id: bookkeeperId,
    event_type: "revert_complete",
    request_payload: {
      message: `Revert complete: ${actionsReverted} merges adjusted, ${totalLinesReverted} lines moved back, ${actionsSkipped} skipped.`,
      actions_reverted: actionsReverted,
      lines_reverted: totalLinesReverted,
      actions_skipped: actionsSkipped,
      errors: errors.slice(0, 10),
    } as any,
  });
}
