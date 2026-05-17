import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getProvinceTax, getServiceTaxRate } from "@/lib/canadian-tax";

/**
 * PATCH /api/stripe-recon/matches/[id]
 *
 * Save a bookkeeper's manual invoice selection for a Stripe recon match.
 * Used when AI matching failed (flagged) and the bookkeeper picked the
 * correct invoices from the candidate pool in the review UI.
 *
 * Body:
 *  {
 *    selected_invoice_ids: string[]   // subset of candidate_invoices ids
 *  }
 *
 * Server-side we:
 *   1. Look up the candidate_invoices snapshot to get amounts + tax detail
 *   2. Recompute pre_tax_revenue, sales_tax_collected, fee, computed_tax
 *   3. Set decision='auto_approve' + bookkeeper_override=true so the row
 *      ships at execute time
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { selected_invoice_ids } = body as { selected_invoice_ids?: string[] };
  if (!Array.isArray(selected_invoice_ids)) {
    return NextResponse.json(
      { error: "selected_invoice_ids must be an array" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Load the match + parent job (need jurisdiction for tax math)
  const { data: match } = await service
    .from("stripe_recon_matches")
    .select("*, stripe_recon_jobs(client_link_id, client_links(jurisdiction, state_province))")
    .eq("id", id)
    .single();

  if (!match) {
    return NextResponse.json({ error: "Match not found" }, { status: 404 });
  }

  const job = (match as any).stripe_recon_jobs;
  const clientLink = job?.client_links;
  const jurisdiction = clientLink?.jurisdiction || "US";
  const stateProvince = clientLink?.state_province || "";

  const candidates: any[] = Array.isArray((match as any).candidate_invoices)
    ? (match as any).candidate_invoices
    : [];

  // If the bookkeeper deselected everything, route back to flagged
  if (selected_invoice_ids.length === 0) {
    await service
      .from("stripe_recon_matches")
      .update({
        matched_invoices: [] as any,
        matched_customer_names: [],
        total_invoice_amount: 0,
        pre_tax_revenue: 0,
        total_sales_tax_collected: 0,
        computed_fee: 0,
        computed_tax: 0,
        decision: "flagged",
        bookkeeper_override: true,
      } as any)
      .eq("id", id);
    return NextResponse.json({ ok: true, decision: "flagged" });
  }

  const picked = candidates.filter((c) => selected_invoice_ids.includes(c.id));
  if (picked.length === 0) {
    return NextResponse.json(
      { error: "None of the selected IDs match the candidate pool" },
      { status: 400 }
    );
  }

  // Tax math — mirror the AI matcher
  const provinceTax = jurisdiction === "CA" ? getProvinceTax(stateProvince) : null;
  const serviceTaxRate = jurisdiction === "CA" ? getServiceTaxRate(stateProvince) : 0;
  const taxCode = provinceTax?.serviceTax.components.join(" + ") || null;

  const matchedInvoices = picked.map((inv) => {
    let preTax: number;
    let taxAmount: number;
    const total = Number(inv.total_amount || 0);
    const qboTax = Number(inv.qbo_total_tax || 0);
    if (qboTax > 0) {
      taxAmount = qboTax;
      preTax = total - taxAmount;
    } else if (serviceTaxRate > 0) {
      preTax = total / (1 + serviceTaxRate);
      taxAmount = total - preTax;
    } else {
      preTax = total;
      taxAmount = 0;
    }
    return {
      invoice_id: inv.id,
      customer_name: inv.customer_name || null,
      amount: Number(total.toFixed(2)),
      pre_tax_amount: Number(preTax.toFixed(2)),
      tax_amount: Number(taxAmount.toFixed(2)),
    };
  });

  const totalInvoiceAmount = matchedInvoices.reduce((s, x) => s + x.amount, 0);
  const preTaxRevenue = matchedInvoices.reduce((s, x) => s + x.pre_tax_amount, 0);
  const totalSalesTaxCollected = matchedInvoices.reduce((s, x) => s + x.tax_amount, 0);
  const grossDiscrepancy = Math.max(0, totalInvoiceAmount - Number(match.deposit_amount || 0));
  const preTaxFee = serviceTaxRate > 0 ? grossDiscrepancy / (1 + serviceTaxRate) : grossDiscrepancy;
  const computedTax = grossDiscrepancy - preTaxFee;

  const customerNames = Array.from(
    new Set(matchedInvoices.map((m) => m.customer_name).filter(Boolean) as string[])
  );

  const { error: updErr } = await service
    .from("stripe_recon_matches")
    .update({
      matched_invoices: matchedInvoices as any,
      matched_customer_names: customerNames,
      total_invoice_amount: Number(totalInvoiceAmount.toFixed(2)),
      pre_tax_revenue: Number(preTaxRevenue.toFixed(2)),
      total_sales_tax_collected: Number(totalSalesTaxCollected.toFixed(2)),
      computed_fee: Number(preTaxFee.toFixed(2)),
      computed_tax: Number(computedTax.toFixed(2)),
      tax_code: taxCode,
      decision: "auto_approve",
      bookkeeper_override: true,
      ai_reasoning:
        (match.ai_reasoning ? match.ai_reasoning + " · " : "") +
        `Manually matched by bookkeeper (${matchedInvoices.length} invoice${matchedInvoices.length === 1 ? "" : "s"})`,
    } as any)
    .eq("id", id);

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    decision: "auto_approve",
    matched_invoices: matchedInvoices,
    total_invoice_amount: Number(totalInvoiceAmount.toFixed(2)),
    pre_tax_revenue: Number(preTaxRevenue.toFixed(2)),
    computed_fee: Number(preTaxFee.toFixed(2)),
    computed_tax: Number(computedTax.toFixed(2)),
  });
}
