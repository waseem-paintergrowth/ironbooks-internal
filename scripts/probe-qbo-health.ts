/**
 * Direct probe of every client_link's QBO refresh chain.
 *
 * Replicates /api/fleet/qbo-health-check using the service role key so
 * we can run it from CLI without an admin session. Persists results to
 * qbo_connection_health exactly like the HTTP endpoint does.
 *
 * Run: npx tsx scripts/probe-qbo-health.ts
 *
 * The 150ms inter-call delay is the same as the endpoint — polite to
 * Intuit's auth quota.
 */

import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

type Status = "ok" | "invalid_grant" | "no_realm" | "other_error";
interface Result {
  client_link_id: string;
  client_name: string;
  status: Status;
  detail: string;
  new_expiry: string | null;
}

(async () => {
  const startedAt = Date.now();
  console.log("\nProbing every active client's QBO refresh chain…\n");

  const { data: clients } = await supa
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("is_active", true)
    .order("client_name");

  const all = (clients as any[]) || [];
  console.log(`  ${all.length} active clients\n`);

  const results: Result[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const tag = `[${String(i + 1).padStart(2, " ")}/${all.length}] ${c.client_name}`;
    if (!c.qbo_realm_id) {
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        status: "no_realm",
        detail: "Never connected to QBO.",
        new_expiry: null,
      });
      console.log(`  ${tag} … \x1b[2mno realm\x1b[0m`);
      continue;
    }
    try {
      await getValidToken(c.id, supa as any, "scripts/probe-qbo-health");
      const { data: fresh } = await supa
        .from("client_links")
        .select("qbo_token_expires_at")
        .eq("id", c.id)
        .single();
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        status: "ok",
        detail: "Refresh succeeded.",
        new_expiry: (fresh as any)?.qbo_token_expires_at || null,
      });
      console.log(`  ${tag} … \x1b[32mok\x1b[0m`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isReauth =
        /invalid_grant|invalid_token|token.*revoked|Incorrect Token type/i.test(msg) ||
        /(QuickBooks connection|QBO connection).*(expired|disconnected|no longer valid)/i.test(msg) ||
        /reconnect QBO/i.test(msg);
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        status: isReauth ? "invalid_grant" : "other_error",
        detail: msg.slice(0, 300),
        new_expiry: null,
      });
      console.log(`  ${tag} … ${isReauth ? "\x1b[31minvalid_grant\x1b[0m" : "\x1b[33mother_error\x1b[0m"}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // Persist exactly the same way the endpoint does so /fleet/qbo-health
  // sees the fresh state.
  const ids = results.map((r) => r.client_link_id);
  const { data: existingRows } = await (supa as any)
    .from("qbo_connection_health")
    .select("client_link_id, status, first_failed_at, last_ok_at")
    .in("client_link_id", ids);
  const existingByClient = new Map<string, any>();
  for (const row of (existingRows as any[]) || []) {
    existingByClient.set(row.client_link_id, row);
  }
  const now = new Date().toISOString();
  const upserts = results.map((r) => {
    const prev = existingByClient.get(r.client_link_id);
    const wasFailing = prev && (prev.status === "invalid_grant" || prev.status === "other_error");
    const isFailingNow = r.status === "invalid_grant" || r.status === "other_error";
    return {
      client_link_id: r.client_link_id,
      status: r.status,
      last_checked_at: now,
      error_message: r.status === "ok" ? null : r.detail,
      last_ok_at: r.status === "ok" ? now : prev?.last_ok_at ?? null,
      first_failed_at: isFailingNow
        ? (wasFailing && prev?.first_failed_at ? prev.first_failed_at : now)
        : null,
      updated_at: now,
    };
  });
  const BATCH = 200;
  for (let i = 0; i < upserts.length; i += BATCH) {
    await (supa as any)
      .from("qbo_connection_health")
      .upsert(upserts.slice(i, i + BATCH), { onConflict: "client_link_id" });
  }

  // Summary
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    invalid_grant: results.filter((r) => r.status === "invalid_grant").length,
    no_realm: results.filter((r) => r.status === "no_realm").length,
    other_error: results.filter((r) => r.status === "other_error").length,
  };
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n─────────────────────────────────");
  console.log(`  Total:           ${summary.total}`);
  console.log(`  \x1b[32mok:\x1b[0m              ${summary.ok}`);
  console.log(`  \x1b[31minvalid_grant:\x1b[0m   ${summary.invalid_grant}`);
  console.log(`  \x1b[33mother_error:\x1b[0m     ${summary.other_error}`);
  console.log(`  \x1b[2mno_realm:\x1b[0m        ${summary.no_realm}`);
  console.log(`  Took ${dur}s`);
  console.log("─────────────────────────────────\n");

  // Movers since the last snapshot
  let recovered = 0, regressed = 0;
  for (const r of results) {
    const prev = existingByClient.get(r.client_link_id);
    if (!prev) continue;
    const prevFailing = prev.status === "invalid_grant" || prev.status === "other_error";
    const nowFailing = r.status === "invalid_grant" || r.status === "other_error";
    if (prevFailing && !nowFailing) recovered++;
    if (!prevFailing && nowFailing) regressed++;
  }
  if (recovered || regressed) {
    console.log(`Since last probe:`);
    if (recovered) console.log(`  \x1b[32m+${recovered} recovered\x1b[0m`);
    if (regressed) console.log(`  \x1b[31m-${regressed} regressed\x1b[0m`);
    console.log("");
  }
  process.exit(0);
})().catch((e) => {
  console.error("\n\x1b[31mprobe failed:\x1b[0m", e?.message || e);
  process.exit(1);
});
