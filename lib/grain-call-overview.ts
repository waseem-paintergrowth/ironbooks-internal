/**
 * AI cross-call overview for a client's Grain recordings.
 *
 * Synthesizes every Ironbooks-hosted call into a couple of plain-English
 * paragraphs — who the client is, what they do, what's come up across the
 * calls, and any standing context a bookkeeper should know walking in.
 *
 * Cached one row per client in grain_call_overviews. The cache key is a
 * `signature` derived from the matched recording count + the latest call's
 * timestamp; when a new call is matched the signature changes and we
 * regenerate. Within an unchanged set, every profile view reuses the cached
 * text — keeps Claude cost at ~pennies per client.
 *
 * Fails soft: returns null if Claude or the cache is unavailable so the UI
 * just hides the overview block.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

const MODEL = "claude-opus-4-7";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface CallOverviewResult {
  overview: string;
  recordingCount: number;
  generatedAt: string;
}

interface RecInput {
  title: string | null;
  start_datetime: string | null;
  summary: string | null; // already-cleaned markdown
  participants?: { name: string | null; email: string | null }[];
}

/** Stable signature for a set of recordings — changes when calls are added/removed. */
function signatureFor(recs: { id: string; start_datetime: string | null }[]): string {
  const latest = recs
    .map((r) => r.start_datetime || "")
    .sort()
    .at(-1) || "";
  return `${recs.length}:${latest}`;
}

/**
 * Cached-first resolver. Reads the cache; if the signature matches the
 * current recording set, returns it. Otherwise regenerates, caches, returns.
 */
export async function getCallOverview(
  service: SupabaseClient,
  clientLinkId: string,
  clientName: string,
  recs: Array<{ id: string; start_datetime: string | null }>,
  detailed: RecInput[]
): Promise<CallOverviewResult | null> {
  if (recs.length === 0) return null;
  const signature = signatureFor(recs);

  // Cache hit?
  try {
    const { data: cached } = await (service as any)
      .from("grain_call_overviews")
      .select("overview, signature, recording_count, generated_at")
      .eq("client_link_id", clientLinkId)
      .single();
    if (cached && cached.signature === signature) {
      return {
        overview: cached.overview,
        recordingCount: cached.recording_count,
        generatedAt: cached.generated_at,
      };
    }
  } catch {
    // table missing / no row — fall through to generate
  }

  const overview = await generateOverview(clientName, detailed);
  if (!overview) return null;

  const generatedAt = new Date().toISOString();
  try {
    await (service as any).from("grain_call_overviews").upsert(
      {
        client_link_id: clientLinkId,
        overview,
        signature,
        recording_count: recs.length,
        generated_at: generatedAt,
      },
      { onConflict: "client_link_id" }
    );
  } catch {
    // cache write failed — still return the fresh overview
  }
  return { overview, recordingCount: recs.length, generatedAt };
}

async function generateOverview(
  clientName: string,
  detailed: RecInput[]
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const callBlocks = detailed
    .map((r, i) => {
      const when = r.start_datetime
        ? new Date(r.start_datetime).toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          })
        : "unknown date";
      const people = (r.participants || [])
        .map((p) => p.name || p.email)
        .filter(Boolean)
        .join(", ");
      return [
        `## Call ${i + 1}: ${r.title || "Untitled"} (${when})`,
        people ? `Client-side participants: ${people}` : "",
        r.summary?.trim() || "(no summary available)",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const prompt = `You are briefing a bookkeeper before they open ${clientName}'s profile. Below are the AI summaries of every call Ironbooks has had with this client.

Write a concise cross-call overview — 2 to 3 short paragraphs — that a bookkeeper can read in 20 seconds to understand:
- Who this client is and what their business does
- The arc across the calls (what was discussed, decisions made, recurring themes)
- Any standing context, preferences, or open threads worth knowing

Rules:
- Plain English, no headings, no bullet lists — just paragraphs.
- Synthesize across ALL calls; don't recap them one by one.
- Don't restate to-do items (those are tracked separately).
- If something is unknown, omit it rather than speculating.

Calls:

${callBlocks}`;

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
