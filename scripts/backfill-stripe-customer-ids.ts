/**
 * Bulk-link every client_link to its Stripe customer by email.
 *
 * For each active client_link with no stripe_customer_id, searches Stripe
 * for a customer matching client_email, and (on a hit) persists the cus_xxx
 * back to client_links. Prints a coverage report: linked / no-match /
 * already-set / no-email, with the no-match list so you can fix emails or
 * link those manually.
 *
 * DRY RUN by default — pass --apply to actually write to the DB.
 *
 * Run:
 *   npx tsx scripts/backfill-stripe-customer-ids.ts          # dry run
 *   npx tsx scripts/backfill-stripe-customer-ids.ts --apply  # write
 *
 * Needs STRIPE_SECRET_KEY + Supabase service-role key in .env.local.
 */

import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const raw of env.split("\n")) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  // Strip a single layer of surrounding quotes if present.
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (key && !process.env[key]) process.env[key] = val;
}

import { createClient } from "@supabase/supabase-js";
import { findStripeCustomerIdByEmail } from "@/lib/stripe-billing";

const APPLY = process.argv.includes("--apply");

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

interface Row {
  id: string;
  client_name: string | null;
  client_email: string | null;
  stripe_customer_id: string | null;
  is_active: boolean | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("✗ STRIPE_SECRET_KEY not set in .env.local");
    process.exit(1);
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — backfilling Stripe customer ids by email\n`);

  const { data, error } = await supa
    .from("client_links")
    .select("id, client_name, client_email, stripe_customer_id, is_active")
    .eq("is_active", true)
    .order("client_name");

  if (error) {
    console.error("✗ client_links query failed:", error.message);
    process.exit(1);
  }

  const rows = (data as Row[]) || [];

  const linked: { name: string; email: string; cus: string }[] = [];
  const noMatch: { name: string; email: string }[] = [];
  const noEmail: { name: string }[] = [];
  let alreadySet = 0;
  let errors = 0;

  for (const row of rows) {
    const name = row.client_name || row.id;

    if (row.stripe_customer_id) {
      alreadySet++;
      continue;
    }
    const email = (row.client_email || "").trim();
    if (!email) {
      noEmail.push({ name });
      continue;
    }

    try {
      const cus = await findStripeCustomerIdByEmail(email);
      if (cus) {
        linked.push({ name, email, cus });
        if (APPLY) {
          const { error: upErr } = await supa
            .from("client_links")
            .update({ stripe_customer_id: cus } as any)
            .eq("id", row.id);
          if (upErr) {
            console.error(`  ✗ failed to write ${name}: ${upErr.message}`);
            errors++;
          }
        }
      } else {
        noMatch.push({ name, email });
      }
    } catch (e: any) {
      console.error(`  ✗ Stripe lookup failed for ${name} (${email}): ${e.message}`);
      errors++;
    }

    // Polite to Stripe's rate limit (100 req/s live, but be gentle).
    await sleep(120);
  }

  // ── Report ──
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS  (${rows.length} active clients)`);
  console.log("=".repeat(60));
  console.log(`  ✓ ${APPLY ? "Linked" : "Would link"}:  ${linked.length}`);
  console.log(`  • Already set:    ${alreadySet}`);
  console.log(`  ⚠ No Stripe match: ${noMatch.length}`);
  console.log(`  ⚠ No email on file: ${noEmail.length}`);
  if (errors) console.log(`  ✗ Errors:         ${errors}`);

  if (linked.length) {
    console.log(`\n${APPLY ? "LINKED" : "WOULD LINK"}:`);
    for (const l of linked) console.log(`  ${l.name}  →  ${l.cus}  (${l.email})`);
  }
  if (noMatch.length) {
    console.log(`\nNO STRIPE MATCH (check the email or link manually):`);
    for (const n of noMatch) console.log(`  ${n.name}  (${n.email})`);
  }
  if (noEmail.length) {
    console.log(`\nNO EMAIL ON FILE (set client_email first):`);
    for (const n of noEmail) console.log(`  ${n.name}`);
  }

  if (!APPLY && linked.length) {
    console.log(`\n→ Re-run with --apply to write these ${linked.length} links.\n`);
  } else {
    console.log("");
  }
})();
