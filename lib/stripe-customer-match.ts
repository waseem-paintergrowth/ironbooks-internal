/**
 * Match an IronBooks client to its Stripe customer for the billing backfill.
 *
 * Only 2 of ~78 clients had a stripe_customer_id because the portal only ever
 * auto-linked by EXACT email — and most clients' Stripe billing email differs
 * from the email on file. This widens matching to three signals, in descending
 * confidence:
 *   1. exact email  — client_email or any linked portal user's email
 *   2. domain tail  — a CUSTOM business domain (e.g. @mypaintingco.com); skip
 *                     generic providers (gmail, etc.) which would over-match
 *   3. company name — normalized name match via Stripe customer search
 *
 * Matching is deliberately CONSERVATIVE: a proposal is only "high" confidence
 * (and pre-selected in the review UI) when it's UNAMBIGUOUS. Anything with
 * competing candidates is surfaced as alternatives for a human to pick — we
 * never silently link the wrong customer (that would show a client the wrong
 * billing data). Nothing here writes; it only proposes.
 */

import {
  listCustomersByEmail,
  searchStripeCustomers,
  type StripeCustomerLite,
} from "@/lib/stripe-billing";

/** Free/consumer email providers — a shared domain here means nothing. */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "comcast.net", "proton.me", "protonmail.com", "gmx.com",
  "sbcglobal.net", "verizon.net", "att.net", "bellsouth.net", "rogers.com",
  "shaw.ca", "telus.net", "hotmail.ca", "yahoo.ca", "live.ca", "outlook.ca",
]);

/** Common business-name noise to strip before comparing names. */
const NAME_STOPWORDS = new Set([
  "inc", "incorporated", "llc", "llc.", "ltd", "ltd.", "limited", "corp",
  "corporation", "co", "company", "the", "and", "&", "painting", "painters",
  "painter", "paint", "contracting", "contractors", "contractor", "services",
  "service", "group", "enterprises", "enterprise", "solutions", "pro", "professional",
]);

function emailDomain(email: string): string | null {
  const m = (email || "").trim().toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : null;
}

function isCustomDomain(domain: string | null): domain is string {
  return !!domain && !GENERIC_EMAIL_DOMAINS.has(domain);
}

/** Normalize a business name to comparable tokens (lowercase, de-noised). */
function nameTokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_STOPWORDS.has(t));
}

function normalizedName(name: string): string {
  return nameTokens(name).join(" ");
}

/** Jaccard-ish token overlap of two names, 0..1. */
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size); // share of the smaller set covered
}

export type MatchConfidence = "high" | "medium" | "low";
export type MatchMethod = "email" | "domain" | "name";

export interface MatchCandidate {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  method: MatchMethod;
  confidence: MatchConfidence;
}

export interface ClientMatchInput {
  clientLinkId: string;
  clientName: string;
  emails: string[]; // client_email + any portal user emails, de-duped
}

export interface ClientMatchProposal {
  clientLinkId: string;
  clientName: string;
  best: MatchCandidate | null;
  alternatives: MatchCandidate[];
  /** True only for an unambiguous high-confidence match (pre-checked in UI). */
  recommended: boolean;
  note: string;
}

const CONF_RANK: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * Propose a Stripe match for one client. Pure-ish: calls Stripe (read-only),
 * returns a ranked proposal. Never writes.
 */
export async function proposeStripeMatch(input: ClientMatchInput): Promise<ClientMatchProposal> {
  const emails = Array.from(
    new Set(input.emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))
  );
  // cusId -> candidate (keep the strongest method/confidence seen for it)
  const byId = new Map<string, MatchCandidate>();

  const consider = (
    c: StripeCustomerLite,
    method: MatchMethod,
    confidence: MatchConfidence
  ) => {
    if (!c?.id) return;
    const existing = byId.get(c.id);
    if (existing && CONF_RANK[existing.confidence] >= CONF_RANK[confidence]) return;
    byId.set(c.id, {
      stripeCustomerId: c.id,
      customerName: c.name,
      customerEmail: c.email,
      method,
      confidence,
    });
  };

  // 1. Exact email (immediate list endpoint) — strongest signal.
  for (const email of emails) {
    const hits = await listCustomersByEmail(email);
    for (const c of hits) consider(c, "email", "high");
  }

  // 2. Custom email-domain tail — only for non-generic domains.
  const domains = Array.from(
    new Set(emails.map(emailDomain).filter(isCustomDomain))
  );
  for (const domain of domains) {
    const hits = await searchStripeCustomers(`email~"@${domain}"`, 25);
    // A single customer on a custom company domain is a strong signal; many
    // (a big team all on the domain) is weaker — fall to medium/alternatives.
    const conf: MatchConfidence = hits.length === 1 ? "high" : "medium";
    for (const c of hits) consider(c, "domain", conf);
  }

  // 3. Company name — normalized token search.
  const tokens = nameTokens(input.clientName);
  if (tokens.length > 0) {
    // Search on the most distinctive token (longest), then score by overlap.
    const probe = [...tokens].sort((a, b) => b.length - a.length)[0];
    const hits = await searchStripeCustomers(`name~"${probe.replace(/"/g, "")}"`, 25);
    for (const c of hits) {
      const sim = nameSimilarity(input.clientName, c.name || "");
      if (sim >= 0.999) consider(c, "name", "high");
      else if (sim >= 0.5) consider(c, "name", "medium");
      else if (sim > 0) consider(c, "name", "low");
    }
  }

  const candidates = Array.from(byId.values()).sort(
    (a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]
  );

  if (candidates.length === 0) {
    return {
      clientLinkId: input.clientLinkId,
      clientName: input.clientName,
      best: null,
      alternatives: [],
      recommended: false,
      note: "No Stripe customer found by email, domain, or name.",
    };
  }

  const best = candidates[0];
  const alternatives = candidates.slice(1);
  const highs = candidates.filter((c) => c.confidence === "high");

  // Recommend (pre-check) ONLY when there's exactly one high-confidence match
  // and nothing else competing at that level — i.e. unambiguous.
  const recommended = highs.length === 1 && best.confidence === "high";
  const note = recommended
    ? `Unambiguous ${best.method} match.`
    : highs.length > 1
      ? "Multiple strong candidates — pick the right one."
      : `Best guess by ${best.method} — confirm before linking.`;

  return {
    clientLinkId: input.clientLinkId,
    clientName: input.clientName,
    best,
    alternatives,
    recommended,
    note,
  };
}
