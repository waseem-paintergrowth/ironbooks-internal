/**
 * Deterministic Stripe AR reconciliation for clients with Stripe Connect.
 *
 * Skips the AI matcher entirely. Pulls payouts + charges directly from
 * Stripe, computes exact fees and customer attribution, then matches each
 * Stripe payout to the QBO Deposit it produced (by arrival_date + amount).
 *
 * For each QBO Deposit we know:
 *   - exact gross charges (sum of charge.amount)
 *   - exact fee (sum of balance_transaction.fee where type='charge')
 *   - per-charge customer email + Stripe invoice id
 *
 * If a charge's customer email matches a QBO customer's PrimaryEmailAddr,
 * we link it. Otherwise the charge is still recorded with its Stripe
 * customer detail so the bookkeeper has full context.
 */

import {
  listPayoutsInRange,
  listBalanceTransactionsForPayout,
  type StripeCharge,
} from "./stripe-api";
import { getProvinceTax, getServiceTaxRate } from "./canadian-tax";
import type {
  StripeDeposit,
  QBOInvoice,
} from "./qbo-stripe-recon";
import type {
  DepositMatch,
  InvoiceMatch,
  CandidateInvoice,
  CandidatePayment,
} from "./claude-stripe-match";

interface QBOCustomer {
  id: string;
  display_name: string;
  primary_email: string | null;
}

export interface StripeApiMatchResult {
  matches: DepositMatch[];
  warnings: string[];
  summary: string;
  /** Stripe payouts we found but couldn't pair with a QBO deposit. */
  unmatched_payouts: Array<{
    payout_id: string;
    arrival_date: string;
    amount: number;
    reason: string;
  }>;
}

interface RunParams {
  accessToken: string;          // Stripe connected-account access token
  jurisdiction: "US" | "CA";
  stateProvince: string;
  /** QBO Deposits we already pulled (Stripe-flagged), to match payouts against */
  qboDeposits: StripeDeposit[];
  /** QBO invoices in the (widened) date range, for invoice→amount lookup */
  qboInvoices: QBOInvoice[];
  /** QBO customers, for email matching */
  qboCustomers: QBOCustomer[];
  /** Stripe payout arrival range — usually matches the job's date range */
  arrivalStartISO: string;
  arrivalEndISO: string;
  /** True if the OAuth token is for live mode (saved at connect time).
   *  Used to surface a clear warning when a sandbox connection is being
   *  used against live cleanup data in production. */
  stripeLivemode?: boolean | null;
  /** True if the platform is running in production (live Stripe keys).
   *  Compared against stripeLivemode to detect mode mismatches. */
  platformLivemode: boolean;
}

const cents = (n: number): number => Math.round(n);
const dollars = (c: number): number => Number((c / 100).toFixed(2));

export async function reconcileViaStripeApi(
  params: RunParams
): Promise<StripeApiMatchResult> {
  const warnings: string[] = [];

  // Mode-mismatch guard: a sandbox connection won't return real payouts.
  // The connection's `livemode` was saved at OAuth callback time.
  if (
    params.stripeLivemode !== undefined &&
    params.stripeLivemode !== null &&
    params.stripeLivemode !== params.platformLivemode
  ) {
    warnings.push(
      params.platformLivemode
        ? "This client is connected via a Stripe TEST/sandbox account, but the app is running in LIVE mode. The Stripe API will return zero real payouts. Send the client a fresh Connect link and have them connect their LIVE Stripe account."
        : "This client is connected via a Stripe LIVE account, but the app is running in TEST mode. Reconciling test cleanup data against live Stripe records is unusual — double-check the environment."
    );
  }

  // 1. Pull payouts
  const allPayouts = await listPayoutsInRange(
    params.accessToken,
    params.arrivalStartISO,
    params.arrivalEndISO
  );

  // Currency filter: only process payouts in the client's home currency.
  // (Stripe accounts can have multi-currency activity; QBO deposits we're
  // pairing against are denominated in the QBO realm currency.) Anything
  // in a different currency would never pair by amount anyway, but we
  // surface a warning so the bookkeeper knows it was skipped on purpose.
  const expectedCurrency = params.jurisdiction === "CA" ? "cad" : "usd";
  const payouts = allPayouts.filter((p) => p.currency.toLowerCase() === expectedCurrency);
  const skippedByCurrency = allPayouts.length - payouts.length;
  if (skippedByCurrency > 0) {
    const otherCurrencies = Array.from(
      new Set(
        allPayouts
          .filter((p) => p.currency.toLowerCase() !== expectedCurrency)
          .map((p) => p.currency.toUpperCase())
      )
    );
    warnings.push(
      `Skipped ${skippedByCurrency} Stripe payout${skippedByCurrency === 1 ? "" : "s"} in ${otherCurrencies.join(", ")} — only ${expectedCurrency.toUpperCase()} payouts can pair with this client's QBO deposits. Multi-currency reconciliation isn't supported yet.`
    );
  }

  // If Stripe has no payouts in the range, we still want to flag the QBO
  // deposits explicitly (so the review screen has rows to show) rather than
  // returning an empty result that looks like "0 matched, 0 anything".
  if (payouts.length === 0) {
    const matches: DepositMatch[] = params.qboDeposits.map((dep) => ({
      qbo_deposit_id: dep.qbo_deposit_id,
      deposit_amount: dep.amount,
      deposit_date: dep.date,
      deposit_memo: dep.memo,
      matched_invoices: [],
      matched_customer_names: [],
      total_invoice_amount: 0,
      pre_tax_revenue: 0,
      total_sales_tax_collected: 0,
      computed_fee: 0,
      computed_tax: 0,
      tax_code: null,
      ai_confidence: 0,
      ai_reasoning:
        "Stripe API returned no payouts in this date range. The QBO deposit shown might be from a different processor, or the connected Stripe account isn't the one that produced it. If the client uses Stripe Sandbox/test mode, reconnect with the live account.",
      decision: "flagged",
      candidate_invoices: [] as CandidateInvoice[],
      candidate_payments: [] as CandidatePayment[],
    }));
    return {
      matches,
      warnings: [
        "No Stripe payouts found in the date range for this connected account. Either Stripe didn't pay out during this period, the connected account is in a different mode (test vs live), or the connected account isn't the one producing these QBO deposits.",
      ],
      summary: `Stripe API: 0 payouts in range, ${matches.length} QBO deposit${matches.length === 1 ? "" : "s"} flagged.`,
      unmatched_payouts: [],
    };
  }

  // 2. Build customer lookup maps for email AND name. Email is the primary
  //    match; name is the fallback when the Stripe charge's email doesn't
  //    appear on a QBO customer (a real-world problem since clients often
  //    use different emails on Stripe vs QBO).
  const customerByEmail = new Map<string, QBOCustomer>();
  const customerByName = new Map<string, QBOCustomer>();
  const normalizeName = (s: string): string =>
    s
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|corporation|company|co|the)\b\.?/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  for (const c of params.qboCustomers) {
    if (c.primary_email) {
      customerByEmail.set(c.primary_email.toLowerCase(), c);
    }
    if (c.display_name) {
      const norm = normalizeName(c.display_name);
      if (norm && !customerByName.has(norm)) {
        // First-match wins on name collisions (rare; usually distinct customers
        // have distinct names). We could log this for the bookkeeper but
        // emitting per-collision warnings would be noisy.
        customerByName.set(norm, c);
      }
    }
  }
  const invoiceById = new Map(params.qboInvoices.map((i) => [i.id, i]));

  // Province tax setup (Canada only)
  const provinceTax =
    params.jurisdiction === "CA" ? getProvinceTax(params.stateProvince) : null;
  const serviceTaxRate =
    params.jurisdiction === "CA" ? getServiceTaxRate(params.stateProvince) : 0;
  const taxCode = provinceTax?.serviceTax.components.join(" + ") || null;

  // Index QBO deposits by amount+date for payout pairing
  const qboDepositsByAmount = new Map<string, StripeDeposit[]>();
  for (const d of params.qboDeposits) {
    const key = Math.round(d.amount * 100).toString();
    const list = qboDepositsByAmount.get(key) || [];
    list.push(d);
    qboDepositsByAmount.set(key, list);
  }

  const matches: DepositMatch[] = [];
  const unmatched_payouts: StripeApiMatchResult["unmatched_payouts"] = [];
  const usedQboDepositIds = new Set<string>();

  for (const payout of payouts) {
    let bts;
    try {
      bts = await listBalanceTransactionsForPayout(params.accessToken, payout.id);
    } catch (err: any) {
      warnings.push(`Could not load transactions for payout ${payout.id}: ${err.message}`);
      continue;
    }

    // Sum gross charges and fees from balance transactions (charge type only —
    // refunds and adjustments are handled separately so the fee math is clean).
    // Because we asked Stripe to expand `data.source`, the charge objects are
    // inlined on each balance transaction — no extra round-trips needed.
    let grossCents = 0;
    let feeCents = 0;
    const inlineCharges: StripeCharge[] = [];
    for (const bt of bts) {
      if (bt.type === "charge" && bt.source) {
        grossCents += bt.amount;
        feeCents += bt.fee;
        if (typeof bt.source === "object") {
          inlineCharges.push(bt.source as StripeCharge);
        }
      } else if (bt.type === "refund") {
        grossCents += bt.amount; // negative
        feeCents += bt.fee;
      } else if (bt.type === "stripe_fee" || bt.type === "adjustment") {
        // Standalone fees / adjustments — fold into fee total
        feeCents += -bt.amount;
      }
    }

    // Pair with a QBO deposit by exact amount (in cents). If multiple, take
    // the closest arrival_date. When 2+ candidates exist, warn — there's
    // an inherent ambiguity the bookkeeper should verify (e.g., two same-
    // amount payouts a day apart).
    const payoutAmountKey = payout.amount.toString();
    const candidates = (qboDepositsByAmount.get(payoutAmountKey) || []).filter(
      (d) => !usedQboDepositIds.has(d.qbo_deposit_id)
    );

    let pairedDeposit: StripeDeposit | null = null;
    let pairingAmbiguous = false;
    if (candidates.length > 0) {
      const arrivalDate = new Date(payout.arrival_date * 1000)
        .toISOString()
        .slice(0, 10);
      candidates.sort((a, b) => {
        const da = Math.abs(new Date(a.date).getTime() - new Date(arrivalDate).getTime());
        const db = Math.abs(new Date(b.date).getTime() - new Date(arrivalDate).getTime());
        return da - db;
      });
      pairedDeposit = candidates[0];
      usedQboDepositIds.add(pairedDeposit.qbo_deposit_id);
      pairingAmbiguous = candidates.length > 1;
    }

    if (!pairedDeposit) {
      unmatched_payouts.push({
        payout_id: payout.id,
        arrival_date: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
        amount: dollars(payout.amount),
        reason:
          "Stripe says this payout was made but no Stripe-flagged QBO Deposit matches the amount. Check that the QBO deposit exists and is on a Stripe clearing account.",
      });
      continue;
    }

    // 3. Charges are already inlined via expand[]=data.source — no fetches needed
    const enrichedCharges: StripeCharge[] = inlineCharges;

    // 4. Build per-customer invoice matches.
    //   For each Stripe charge:
    //     - get the receipt_email / billing_details.email / customer email
    //     - if we can find a matching QBO customer by email, attribute the
    //       charge amount to that customer
    //     - if Stripe's `invoice` field is set, try to find the QBO invoice
    //       with that Stripe invoice id stored in PrivateNote/DocNumber
    //       (best-effort; not all clients sync invoice IDs back)
    const customerTotals = new Map<
      string,
      { customer_name: string; gross_cents: number; charge_ids: string[]; emails: Set<string> }
    >();
    const unattributed: { gross_cents: number; charge_ids: string[] } = { gross_cents: 0, charge_ids: [] };

    for (const ch of enrichedCharges) {
      const email = (ch.receipt_email || ch.billing_details?.email || "").toLowerCase().trim();
      // Try email first (most reliable when present), then name fallback.
      let qboCust: QBOCustomer | undefined = email
        ? customerByEmail.get(email)
        : undefined;
      if (!qboCust) {
        const candidateName = ch.billing_details?.name || "";
        if (candidateName) {
          const norm = normalizeName(candidateName);
          if (norm) qboCust = customerByName.get(norm);
        }
      }
      if (qboCust) {
        const entry =
          customerTotals.get(qboCust.id) ||
          {
            customer_name: qboCust.display_name,
            gross_cents: 0,
            charge_ids: [] as string[],
            emails: new Set<string>(),
          };
        entry.gross_cents += ch.amount;
        entry.charge_ids.push(ch.id);
        if (email) entry.emails.add(email);
        customerTotals.set(qboCust.id, entry);
      } else {
        // No QBO customer match by email OR by name — record as unattributed
        unattributed.gross_cents += ch.amount;
        unattributed.charge_ids.push(ch.id);
      }
    }

    const matchedInvoices: InvoiceMatch[] = [];
    for (const [qboCustId, entry] of customerTotals) {
      const grossDollars = dollars(entry.gross_cents);
      let preTax = grossDollars;
      let taxAmount = 0;
      if (serviceTaxRate > 0) {
        preTax = grossDollars / (1 + serviceTaxRate);
        taxAmount = grossDollars - preTax;
      }
      const chargeCount = entry.charge_ids.length;
      matchedInvoices.push({
        // For the Stripe API path we attribute at the customer level — there's
        // no QBO invoice mapping. invoice_id is set to the Stripe payout id
        // so we have a stable, identifiable reference (not a fake number).
        invoice_id: payout.id,
        customer_name: entry.customer_name,
        amount: Number(grossDollars.toFixed(2)),
        pre_tax_amount: Number(preTax.toFixed(2)),
        tax_amount: Number(taxAmount.toFixed(2)),
        qbo_customer_id: qboCustId,
        description_label: `${chargeCount} Stripe charge${chargeCount === 1 ? "" : "s"} · payout ${payout.id}`,
      });
    }

    // If we have unattributed Stripe charges, add a line so the totals
    // reconcile. Description makes it clear these are unattributed (no
    // QBO customer match) — the bookkeeper can re-tag in QBO after.
    if (unattributed.gross_cents > 0) {
      const grossDollars = dollars(unattributed.gross_cents);
      let preTax = grossDollars;
      let taxAmount = 0;
      if (serviceTaxRate > 0) {
        preTax = grossDollars / (1 + serviceTaxRate);
        taxAmount = grossDollars - preTax;
      }
      const n = unattributed.charge_ids.length;
      matchedInvoices.push({
        invoice_id: payout.id,
        customer_name: null, // no QBO customer to attribute to
        amount: Number(grossDollars.toFixed(2)),
        pre_tax_amount: Number(preTax.toFixed(2)),
        tax_amount: Number(taxAmount.toFixed(2)),
        qbo_customer_id: null,
        description_label: `${n} unattributed Stripe charge${n === 1 ? "" : "s"} (no QBO customer match by email) · payout ${payout.id}`,
      });
    }

    const totalInvoiceAmount = dollars(grossCents);
    const computedFeeRaw = dollars(feeCents);
    const preTaxFee =
      serviceTaxRate > 0
        ? computedFeeRaw / (1 + serviceTaxRate)
        : computedFeeRaw;
    const computedTax = computedFeeRaw - preTaxFee;

    const customerNames = Array.from(
      new Set(matchedInvoices.map((m) => m.customer_name).filter(Boolean) as string[])
    );

    // Safety net: payouts with no charge-type balance transactions (all-fee
    // adjustment payouts, refund-only payouts, etc.) shouldn't auto-approve
    // — there's nothing on the income side to balance the fee line, and
    // executing would break the deposit math in QBO. Flag for manual review.
    let decision: "auto_approve" | "needs_review" | "flagged" = "auto_approve";
    let reasoning = `Matched via Stripe API: payout ${payout.id} → ${enrichedCharges.length} charge${enrichedCharges.length === 1 ? "" : "s"}, exact fee $${computedFeeRaw.toFixed(2)}.`;
    if (matchedInvoices.length === 0 || totalInvoiceAmount <= 0) {
      decision = "flagged";
      reasoning =
        `Stripe payout ${payout.id} paired by amount, but it has no charge-type ` +
        `balance transactions (likely a refund-only / fee-adjustment payout). ` +
        `Auto-execute would unbalance the QBO deposit — inspect and apply manually.`;
    } else if (pairingAmbiguous) {
      // Same-amount candidates: don't auto-execute on a guess. Demote so
      // the bookkeeper confirms before this writes to QBO.
      decision = "needs_review";
      reasoning =
        reasoning +
        ` Note: ${candidates.length} QBO deposits had this exact amount — we paired the closest by date but please verify before approving.`;
    }

    matches.push({
      qbo_deposit_id: pairedDeposit.qbo_deposit_id,
      deposit_amount: pairedDeposit.amount,
      deposit_date: pairedDeposit.date,
      deposit_memo: pairedDeposit.memo,
      matched_invoices: matchedInvoices,
      matched_customer_names: customerNames,
      total_invoice_amount: Number(totalInvoiceAmount.toFixed(2)),
      pre_tax_revenue: Number(
        matchedInvoices.reduce((s, m) => s + m.pre_tax_amount, 0).toFixed(2)
      ),
      total_sales_tax_collected: Number(
        matchedInvoices.reduce((s, m) => s + m.tax_amount, 0).toFixed(2)
      ),
      computed_fee: Number(preTaxFee.toFixed(2)),
      computed_tax: Number(computedTax.toFixed(2)),
      tax_code: taxCode,
      ai_confidence:
        decision === "auto_approve" ? 1.0 : decision === "needs_review" ? 0.7 : 0.5,
      ai_reasoning: reasoning,
      decision,
      candidate_invoices: [] as CandidateInvoice[],
      candidate_payments: [] as CandidatePayment[],
    });
  }

  // Any QBO deposits we didn't pair → flagged with a clear reason
  for (const dep of params.qboDeposits) {
    if (usedQboDepositIds.has(dep.qbo_deposit_id)) continue;
    matches.push({
      qbo_deposit_id: dep.qbo_deposit_id,
      deposit_amount: dep.amount,
      deposit_date: dep.date,
      deposit_memo: dep.memo,
      matched_invoices: [],
      matched_customer_names: [],
      total_invoice_amount: 0,
      pre_tax_revenue: 0,
      total_sales_tax_collected: 0,
      computed_fee: 0,
      computed_tax: 0,
      tax_code: taxCode,
      ai_confidence: 0,
      ai_reasoning:
        "Stripe API path: no Stripe payout matched this QBO deposit's amount. Either the deposit isn't from Stripe, or it's from a different connected account. Inspect the deposit memo and account.",
      decision: "flagged",
      candidate_invoices: [] as CandidateInvoice[],
      candidate_payments: [] as CandidatePayment[],
    });
  }

  if (unmatched_payouts.length > 0) {
    warnings.push(
      `${unmatched_payouts.length} Stripe payout${unmatched_payouts.length === 1 ? "" : "s"} had no matching QBO deposit. Check that those deposits were imported into QBO and posted to a Stripe clearing account.`
    );
  }

  const autoCount = matches.filter((m) => m.decision === "auto_approve").length;
  const flaggedCount = matches.filter((m) => m.decision === "flagged").length;
  void invoiceById; // future-proofing for per-invoice attribution

  return {
    matches,
    warnings,
    summary: `Stripe API: ${autoCount} payouts reconciled, ${flaggedCount} unmatched.`,
    unmatched_payouts,
  };
}
