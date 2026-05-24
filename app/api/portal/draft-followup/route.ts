import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";

/**
 * POST /api/portal/draft-followup
 *
 * Generates a polite, on-brand follow-up email for a specific overdue
 * customer. Returns plain text the client can copy-paste into their
 * email tool of choice.
 *
 * Body:
 *   {
 *     customer_name: string,
 *     total_owed: number,
 *     oldest_days_overdue: number,
 *     invoices: { num: string; amount: number; days_overdue: number }[],
 *     last_payment_date?: string | null,
 *     tone?: "friendly" | "firm" | "final"   // default: friendly
 *   }
 *
 * Returns: { subject: string, body: string }
 *
 * Not streamed — these are short emails, full response in one shot.
 * Rate-limited via the same portal_ai_usage table as Ask AI (counts as
 * one message). Skipped when impersonating.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = "claude-opus-4-7";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TONE_GUIDANCE: Record<string, string> = {
  friendly:
    "Warm and casual. The relationship is still good — assume the late payment is a busy oversight, not bad faith. No threats, no escalation language.",
  firm:
    "Professional and direct. Make it clear this isn't the first reminder, that prompt payment matters, and ask for a specific commitment by a specific date. Stay polite.",
  final:
    "Last-chance tone. Explicit that this is the final reminder before next steps (which the user will decide separately — don't name them). Still professional, no anger.",
};

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({} as any));
  const customerName: string = (body.customer_name || "").trim();
  const totalOwed: number = Number(body.total_owed) || 0;
  const oldestDays: number = Number(body.oldest_days_overdue) || 0;
  const invoices: Array<{ num: string; amount: number; days_overdue: number }> =
    Array.isArray(body.invoices) ? body.invoices.slice(0, 20) : [];
  const lastPaymentDate: string | null = body.last_payment_date || null;
  const tone: string = ["friendly", "firm", "final"].includes(body.tone) ? body.tone : "friendly";

  if (!customerName) {
    return NextResponse.json({ error: "customer_name is required" }, { status: 400 });
  }
  if (totalOwed <= 0) {
    return NextResponse.json({ error: "total_owed must be positive" }, { status: 400 });
  }

  const systemPrompt = `You are drafting a follow-up email FOR a small business owner to send to one of THEIR customers about overdue invoices. The business owner is your user — they will copy-paste this into their email tool.

TONE: ${TONE_GUIDANCE[tone]}

HARD RULES:
1. Address the customer by name in the greeting.
2. Reference the specific invoice number(s) and amount(s). Cite the longest-overdue invoice prominently.
3. Make the ask concrete. Suggest a clear next step (a payment date, a check-in call, or a reply with status).
4. Keep it to 4-7 sentences. No filler.
5. End with a warm sign-off. Sign as "{{OWNER_NAME}}" — leave that placeholder literal so the user can fill in their own name.
6. NEVER threaten legal action, late fees, collections, or service interruption. NEVER mention this is an automated/AI-drafted email.
7. Return STRICTLY valid JSON: { "subject": "...", "body": "..." } — no markdown, no preamble.

Subject lines: short, descriptive, NOT alarming. "Quick check on invoice INV-1042" beats "URGENT: PAYMENT PAST DUE".`;

  const invoiceSummary = invoices.length > 0
    ? invoices.map((i) => `  - Invoice ${i.num}: $${i.amount.toLocaleString()} (${i.days_overdue}d overdue)`).join("\n")
    : `  Total owed: $${totalOwed.toLocaleString()}, ${oldestDays} days past due`;

  const userMessage = `Draft a follow-up email from ${ctx.clientName} to ${customerName}.

Context:
${invoiceSummary}
Total outstanding: $${totalOwed.toLocaleString()}
Oldest invoice age: ${oldestDays} days past due${lastPaymentDate ? `
Last payment received from this customer: ${lastPaymentDate}` : ""}

Tone: ${tone}

Return ONLY the JSON.`;

  let parsed: { subject: string; body: string };
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = response.content.find((c: any) => c.type === "text");
    if (!block || block.type !== "text") throw new Error("Empty response");
    const raw = block.text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return NextResponse.json(
      { error: `AI draft failed: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  }

  if (!parsed.subject || !parsed.body) {
    return NextResponse.json(
      { error: "AI returned malformed draft (missing subject/body)" },
      { status: 500 }
    );
  }

  // Replace the {{OWNER_NAME}} placeholder with the portal user's name if
  // available — usually the business owner. Falls back to leaving the
  // literal placeholder if no name is on file.
  const ownerName = ctx.userFullName || "{{OWNER_NAME}}";
  parsed.body = parsed.body.replace(/\{\{OWNER_NAME\}\}/g, ownerName);

  return NextResponse.json({
    ok: true,
    subject: parsed.subject,
    body: parsed.body,
    tone,
  });
}
