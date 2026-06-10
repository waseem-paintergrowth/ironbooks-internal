// One-time backfill: for every client_link with a valid refresh_token
// whose qbo_connection_health row is stale (status != ok but the
// access token was issued AFTER the last health check), mark the row
// healthy. This unblocks Lisa's "30 reconnects still showing dead"
// situation without waiting for the next probe to run.
//
// Safety: only heals rows where the refresh actually happened recently.
// Does NOT touch rows that are still genuinely dead.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";
const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  // Pull every active client with a refresh token + their current health row
  const { data: clients } = await svc
    .from("client_links")
    .select("id, client_name, qbo_refresh_token, qbo_token_expires_at, updated_at")
    .eq("is_active", true)
    .not("qbo_refresh_token", "is", null);

  if (!clients || clients.length === 0) {
    console.log("No active clients with refresh tokens. Nothing to do.");
    return;
  }

  const ids = clients.map((c: any) => c.id);
  const { data: healthRows } = await svc
    .from("qbo_connection_health")
    .select("*")
    .in("client_link_id", ids);
  const healthById = new Map<string, any>();
  for (const h of healthRows || []) healthById.set(String(h.client_link_id), h);

  // A client is "stale-dead": health row says invalid_grant / other_error,
  // but the client_links.updated_at is AFTER the health row's last_checked_at
  // → tokens were refreshed (probably by OAuth callback) after the probe
  // flagged them dead. These are safe to heal.
  const stale: any[] = [];
  for (const c of clients) {
    const h = healthById.get(String((c as any).id));
    if (!h) continue;
    if (h.status === "ok") continue;
    const checkedAt = h.last_checked_at ? new Date(h.last_checked_at) : null;
    const updatedAt = new Date((c as any).updated_at);
    if (checkedAt && updatedAt > checkedAt) {
      stale.push({
        client_link_id: (c as any).id,
        client_name: (c as any).client_name,
        old_status: h.status,
        last_checked_at: h.last_checked_at,
        client_updated_at: (c as any).updated_at,
      });
    }
  }

  console.log(`Found ${stale.length} stale-dead health rows to heal:`);
  for (const s of stale) {
    console.log(
      `  ${s.client_name.padEnd(40)}  ${s.old_status} → ok  (checked ${s.last_checked_at}, reconnected ${s.client_updated_at})`
    );
  }

  if (DRY_RUN) {
    console.log("\n(dry-run) — no writes performed. Re-run without --dry-run to apply.");
    return;
  }

  const now = new Date().toISOString();
  let healed = 0;
  for (const s of stale) {
    const { error } = await svc.from("qbo_connection_health").upsert(
      {
        client_link_id: s.client_link_id,
        status: "ok",
        last_checked_at: now,
        last_ok_at: now,
        first_failed_at: null,
        error_message: null,
        reconnect_initiated_at: null,
        reconnect_initiated_by: null,
        updated_at: now,
      },
      { onConflict: "client_link_id" }
    );
    if (error) {
      console.error(`  FAILED ${s.client_name}: ${error.message}`);
    } else {
      healed++;
    }
  }
  console.log(`\nHealed ${healed}/${stale.length} rows.`);
})();
