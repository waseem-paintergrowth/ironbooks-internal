import { KB_CATEGORIES } from "@/lib/kb-content";
import { KnowledgeBaseClient } from "./kb-client";

export const dynamic = "force-dynamic";

/**
 * /portal/knowledge-base — the client-facing FAQ.
 *
 * AI search on top (grounded strictly in the KB content), accordion of all
 * 13 categories / 50+ Q&As below. Auth comes from the portal layout.
 */
export default function KnowledgeBasePage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-navy">Knowledge Base</h1>
      <p className="text-sm text-ink-slate mt-1 mb-6">
        Answers to the questions painting-business owners ask us most. Search in
        plain English, or browse by topic below.
      </p>
      <KnowledgeBaseClient categories={KB_CATEGORIES} />
    </div>
  );
}
