import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { KB_CATEGORIES } from "@/lib/kb-content";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/portal/kb-search — AI search over the client Knowledge Base.
 *
 * Body: { question: string }
 *
 * Grounded STRICTLY in lib/kb-content.ts — the same 13 categories / 50+
 * answers rendered in the accordion below the search box. The model answers
 * from that text only and cites which FAQ entries it drew from (returned as
 * ids so the UI can deep-link / auto-expand them). Questions outside the
 * KB get a polite "ask your bookkeeper via Messages" instead of a guess.
 *
 * Distinct from /portal/ask-ai (which answers from the client's own
 * financial data) — this one is process/educational content, identical for
 * every client, so there's no client data in the prompt at all.
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }

  let body: { question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const question = (body.question || "").trim().slice(0, 1000);
  if (!question) {
    return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  }

  // id → metadata lookup for validating the model's citations
  const itemIndex = new Map<string, { category: string; question: string }>();
  for (const cat of KB_CATEGORIES) {
    for (const item of cat.items) {
      itemIndex.set(item.id, { category: cat.title, question: item.question });
    }
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are the Ironbooks Knowledge Base assistant inside a client portal for painting-contractor business owners. Answer the client's question using ONLY the knowledge base below. Plain English, friendly, concise (under 250 words). Use the same advice and numbers the KB gives — do not invent policy, thresholds, or tax advice beyond it. If the KB genuinely doesn't cover the question, say so and point them to the Messages page to ask their bookkeeper directly.

Each KB entry has an id in square brackets before its question. After answering, cite the entries you actually used.

KNOWLEDGE BASE:
${KB_CATEGORIES.map(
  (cat) =>
    `## ${cat.title}\n` +
    cat.items.map((i) => `[${i.id}] ${i.question}\n${i.answer}`).join("\n\n")
).join("\n\n")}

CLIENT QUESTION: ${question}

Respond with ONLY a JSON object:
{"answer": "<your answer, markdown-lite: **bold**, '- ' bullets, blank-line paragraphs>", "source_ids": ["<id>", ...]}`;

  try {
    const res = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    const parsed = JSON.parse(match[0]);

    const sources = (Array.isArray(parsed.source_ids) ? parsed.source_ids : [])
      .filter((id: any) => typeof id === "string" && itemIndex.has(id))
      .slice(0, 6)
      .map((id: string) => ({ id, ...itemIndex.get(id)! }));

    return NextResponse.json({
      ok: true,
      answer: String(parsed.answer || "").slice(0, 4000),
      sources,
    });
  } catch (err: any) {
    console.error("[kb-search] failed:", err?.message);
    return NextResponse.json(
      { error: "Search is having a moment — try again, or browse the categories below." },
      { status: 500 }
    );
  }
}

// Keep an eye on prompt size if the KB grows much past ~10k words; at that
// point switch to a two-step retrieve-then-answer. Today it fits comfortably.
