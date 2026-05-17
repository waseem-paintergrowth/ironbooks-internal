/**
 * Claude AI Integration for Bank Rule Discovery
 * ----------------------------------------------
 * Takes grouped vendor transactions and the Ironbooks master COA,
 * returns structured rule suggestions: vendor → account mapping with confidence.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VendorGroup } from "./qbo-rules";
import type { MasterCOAEntry } from "./claude";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

export interface RuleSuggestion {
  vendor_pattern: string;
  target_account_name: string;
  confidence: number;
  reasoning: string;
  requires_approval: boolean;     // true for tax-sensitive vendors
  suggested_match_type: "Contains" | "StartsWith" | "Is";
}

export interface RuleAnalysisResult {
  suggestions: RuleSuggestion[];
  unmatched: string[];            // vendors AI couldn't confidently categorize
  warnings: string[];
  summary: string;
}

const SYSTEM_PROMPT = `You are the Ironbooks AI Bookkeeper analyzing vendor patterns for a painting contractor.

Your job: Take a list of grouped vendor transactions and map each vendor to the correct Ironbooks Master COA account.

For each vendor group, decide:
- Which master account does this vendor's spend belong in?
- How confident are you? (0.00-1.00)
- Does this rule require human approval before deploying? (tax/payroll/owner-related = YES)

CRITICAL RULES:
1. Confidence 0.90+ ONLY for obvious painter vendors (Sherwin-Williams → Paint & Materials).
2. Mark requires_approval=TRUE for: payroll providers, tax payments, owner draws/distributions, large recurring amounts.
3. Use the vendor's transaction history (what accounts they currently land in) as a strong signal - if Sherwin-Williams currently posts to "Paint Supplies", that's evidence it should map to "Paint & Materials" in master.
4. Use "StartsWith" match type for vendors with consistent prefixes (e.g., "SHERWIN"). Use "Contains" otherwise.
5. If you can't confidently map a vendor to any master account, put it in "unmatched" array - do NOT guess.
6. Reasoning must be SHORT (one sentence) and specific to this vendor.

For painter context, common patterns:
- Sherwin-Williams, Benjamin Moore, Dunn-Edwards, PPG → "Paint & Materials"
- Home Depot, Lowes, Rona → "Job Supplies" (often, but Home Depot can be mixed)
- Shell, Chevron, Esso, Petro-Canada, Costco Gas → "Fuel – Admin & Sales Vehicles"
- Gusto, ADP, Wagepoint, Payworks, Wave Payroll → "Owner Draw / Salary" or "Admin Team Salaries" (FLAG for review)
- State Farm, Intact, Aviva, Wawanesa → Insurance accounts
- Verizon, Rogers, Bell, Telus → Utilities or specific Phone account
- Stripe, Square, Helcim → Revenue (income)
- IRS, CRA, State tax payments → FLAG, never auto-categorize

Return STRICTLY valid JSON:
{
  "suggestions": [
    {
      "vendor_pattern": "string",
      "target_account_name": "string (exact name from master COA)",
      "confidence": 0.00-1.00,
      "reasoning": "string (one sentence)",
      "requires_approval": boolean,
      "suggested_match_type": "Contains" | "StartsWith" | "Is"
    }
  ],
  "unmatched": ["vendor patterns that couldn't be confidently mapped"],
  "warnings": ["structural concerns"],
  "summary": "one paragraph overview"
}

No markdown fences. No preamble. Just the JSON object.`;

export async function analyzeBankRules(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  vendorGroups: VendorGroup[];
  masterCOA: MasterCOAEntry[];
}): Promise<RuleAnalysisResult> {
  // Compact the master COA - only need non-parent leaf accounts for rule targets
  const validTargets = params.masterCOA
    .filter((m) => !m.is_parent)
    .map((m) => ({
      name: m.account_name,
      type: m.qbo_account_type,
      parent: m.parent_account_name,
      tax_note: m.tax_treatment?.note,
    }));

  const compactVendors = params.vendorGroups.map((v) => ({
    vendor: v.vendor_pattern,
    tx_count: v.transaction_count,
    total: Math.round(v.total_amount),
    samples: v.sample_descriptions.slice(0, 3),
    currently_posts_to: v.primary_current_account,
  }));

  const userMessage = `
CLIENT: ${params.clientName}
JURISDICTION: ${params.jurisdiction}
INDUSTRY: Residential Painting Contractor

===== VALID TARGET ACCOUNTS (from Ironbooks Master COA) =====
${JSON.stringify(validTargets, null, 2)}

===== VENDOR GROUPS DISCOVERED (last 6 months) =====
${JSON.stringify(compactVendors, null, 2)}

Analyze each vendor and produce rule suggestions. Return the structured JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as RuleAnalysisResult;
    return validateRuleAnalysis(parsed, params.masterCOA);
  } catch (err: any) {
    throw new Error(
      `Failed to parse rule analysis: ${err.message}\nResponse: ${cleaned.slice(0, 500)}`
    );
  }
}

/**
 * Sanity-check Claude's output before trusting it.
 */
function validateRuleAnalysis(
  analysis: RuleAnalysisResult,
  masterCOA: MasterCOAEntry[]
): RuleAnalysisResult {
  const validNames = new Set(masterCOA.filter((m) => !m.is_parent).map((m) => m.account_name));
  const warnings = [...(analysis.warnings || [])];

  // Filter suggestions to only those pointing at valid master accounts
  const cleanSuggestions: RuleSuggestion[] = [];
  for (const s of analysis.suggestions) {
    if (!validNames.has(s.target_account_name)) {
      warnings.push(`Dropped: "${s.vendor_pattern}" → invalid target "${s.target_account_name}"`);
      continue;
    }

    // Clamp confidence
    s.confidence = Math.max(0, Math.min(1, s.confidence));

    // Force requires_approval for sensitive patterns
    const sensitive = /payroll|tax|irs|cra|owner|draw|distribution|salary|wage|gusto|adp/i.test(
      s.vendor_pattern + " " + s.target_account_name
    );
    if (sensitive) s.requires_approval = true;

    cleanSuggestions.push(s);
  }

  return {
    suggestions: cleanSuggestions,
    unmatched: analysis.unmatched || [],
    warnings,
    summary: analysis.summary || "",
  };
}
