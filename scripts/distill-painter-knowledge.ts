/**
 * One-shot distiller: reads PainterGrowth call_insights (client_safe
 * field only — never raw transcripts), asks Claude to extract a curated
 * painter-industry knowledge brief, and overwrites
 * lib/painter-industry-knowledge.ts with the result.
 *
 * Run when you want to refresh the AI's painter knowledge from the
 * latest coaching insights:
 *
 *   npx tsx scripts/distill-painter-knowledge.ts
 *
 * Then `git diff lib/painter-industry-knowledge.ts` to review what
 * changed before committing. Anything that goes in the brief is visible
 * to every portal client — review carefully for:
 *   - Specific clients, coaches, or revenue figures (must NOT appear)
 *   - Tax / legal / brand advice (must NOT appear)
 *   - Anything that contradicts what an Ironbooks bookkeeper would say
 *
 * Env vars:
 *   COACHING_SUPABASE_URL              — PainterGrowth Supabase
 *   COACHING_SUPABASE_SERVICE_ROLE_KEY — PainterGrowth service role
 *   ANTHROPIC_API_KEY                  — Claude API key
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// Load .env.local before importing anything that touches process.env
const envText = readFileSync(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-7";
const TARGET_PATH = resolve("lib/painter-industry-knowledge.ts");

const coaching = createClient(
  process.env.COACHING_SUPABASE_URL!,
  process.env.COACHING_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a domain-knowledge curator extracting a focused, factual painter-industry knowledge brief from anonymized coaching-call insights about residential painting businesses.

The brief will be baked into an AI assistant's system prompt and shown to every portal user. It must be tight, fact-dense, and free of:
- Specific client names, coach names, or company names
- Specific revenue figures from individual businesses
- Tax or legal advice
- Specific product/vendor recommendations by brand
- Coaching-style anecdotes ("one painter told us...")

Output a 1200–1800 token brief in the EXACT structure below, using the source insights as input. Be specific with ranges (e.g. "30–50%"), terse (no filler), and painter-vocabulary-fluent.

REQUIRED STRUCTURE — output as plain text (no markdown headers) with these sections in this order:

═══ PAINTER INDUSTRY KNOWLEDGE (curated baseline — used to make the assistant fluent in the painting trade) ═══

— FINANCIAL TARGETS (residential repaint / light commercial) —
[direct labor %, materials %, gross profit %, overhead %, net profit %]

— SALES / PIPELINE BENCHMARKS —
[close rates by segment, average estimates per closed job, qualifying-process impact]

— OPERATING REALITIES —
[seasonality, cash flow timing, crew vs sub economics, estimating accuracy as margin lever]

— COMMON COST CATEGORIES (and what painters confuse) —
[5-7 common bookkeeping miscategorizations specific to painters]

— LANGUAGE PAINTERS USE —
[10-15 trade terms with brief definitions]

— SCALING PATTERNS —
[revenue bands and what changes at each]

— FREQUENT PAIN POINTS PAINTERS ASK ABOUT —
[5-7 common questions with framing for how the AI should answer]

═══ END PAINTER INDUSTRY KNOWLEDGE ═══

Hard rules:
- Use ONLY information that's in or directly implied by the input insights. If a section has thin source material, write less — never invent.
- No section may exceed ~250 tokens.
- Specific numbers must come from the source insights. Where they conflict, use a range.
- Anything that smells like coaching anecdote ("one client said") gets rewritten as a general pattern or dropped.`;

async function main() {
  console.log("\nDistilling painter knowledge from PainterGrowth call_insights\n");

  // Pull every call_insights row with non-null client_safe. We only feed
  // the client_safe field to Claude — never raw transcripts.
  const { data: rows, error } = await coaching
    .from("call_insights" as any)
    .select("call_class, revenue_band, contractor_segment, topics, client_safe, outcome, sentiment")
    .not("client_safe", "is", null);
  if (error) throw new Error(`Source read failed: ${error.message}`);
  const all = (rows as any[]) || [];
  console.log(`  ${all.length} insights with client_safe content`);

  if (all.length === 0) {
    console.log("Nothing to distill. Done.");
    return;
  }

  // Build a compact source dump for Claude. Each row → small structured
  // block. We cap total characters to stay under input-token budget on
  // the model — Opus accepts ~200k input tokens but we want fast +
  // focused, so keep input ~50k tokens.
  const MAX_CHARS = 200_000;
  const blocks: string[] = [];
  for (const r of all) {
    let safe = r.client_safe;
    if (typeof safe === "string") {
      try { safe = JSON.parse(safe); } catch { /* keep as string */ }
    }
    const safeText = typeof safe === "string"
      ? safe
      : JSON.stringify(safe, null, 2);
    const header = [
      r.call_class && `class=${r.call_class}`,
      r.revenue_band && `revenue=${r.revenue_band}`,
      r.contractor_segment && `segment=${r.contractor_segment}`,
      Array.isArray(r.topics) && r.topics.length > 0 && `topics=${r.topics.join("|")}`,
    ].filter(Boolean).join(" ");
    blocks.push(`--- ${header} ---\n${safeText.slice(0, 3000)}`);
    if (blocks.join("\n\n").length > MAX_CHARS) {
      console.log(`  Truncating source dump at ${blocks.length} rows (~${MAX_CHARS} chars)`);
      break;
    }
  }
  const sourceDump = blocks.join("\n\n");
  console.log(`  Sending ${blocks.length} insights to Claude (~${Math.round(sourceDump.length / 4)} input tokens)`);

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Distill these painter-coaching insights into the structured brief described in the system prompt. Source insights below.\n\n${sourceDump}`,
    }],
  });

  const brief = resp.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

  if (!brief.includes("PAINTER INDUSTRY KNOWLEDGE")) {
    throw new Error("Claude output didn't include the expected header — bailing without overwriting the file.");
  }

  // Wrap the brief in the TypeScript module template. Preserves the
  // existing file's leading comment so future devs know how to refresh.
  const fileBody = `/**
 * Painter-industry knowledge brief — baked into the Portal Ask AI's
 * system prompt so responses feel painter-fluent without retrieving
 * from a live coaching corpus.
 *
 * Generated by scripts/distill-painter-knowledge.ts on ${new Date().toISOString()}
 * from ${all.length} anonymized PainterGrowth call_insights rows.
 *
 * REVIEW BEFORE COMMITTING. Anything in this string is visible to every
 * portal client. Check for:
 *   - Specific clients, coaches, or revenue figures
 *   - Tax / legal / brand advice
 *   - Coaching anecdotes that should be rewritten as patterns
 *
 * Re-run the distiller to refresh from the latest insights:
 *   npx tsx scripts/distill-painter-knowledge.ts
 */

export const PAINTER_INDUSTRY_KNOWLEDGE = ${JSON.stringify(brief)};
`;

  writeFileSync(TARGET_PATH, fileBody, "utf8");
  console.log(`\n  Wrote ${TARGET_PATH}`);
  console.log(`  Input tokens:  ${resp.usage.input_tokens}`);
  console.log(`  Output tokens: ${resp.usage.output_tokens}`);
  console.log(`  Est. cost (Opus): $${((resp.usage.input_tokens / 1_000_000) * 15 + (resp.usage.output_tokens / 1_000_000) * 75).toFixed(4)}`);
  console.log(`\n  Next: \`git diff lib/painter-industry-knowledge.ts\` to review.\n`);
}

main().catch((e) => {
  console.error("\nDistiller failed:", e?.message || e);
  process.exit(1);
});
