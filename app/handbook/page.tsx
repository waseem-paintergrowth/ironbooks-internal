import { AppShell } from "@/components/AppShell";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BOOKKEEPER_HANDBOOK_HTML } from "@/lib/handbook-html";

export const dynamic = "force-dynamic";

/**
 * /handbook — the SNAP Bookkeeper Handbook (internal knowledge base).
 *
 * The handbook is a self-contained HTML document with its own (aggressive,
 * global) styling, so we render it inside an `srcDoc` iframe — that gives it a
 * separate document context, fully isolating its CSS from the app shell. The
 * markup is bundled as a string (lib/handbook-html.ts) so it ships with the
 * deploy and is delivered only to logged-in staff (middleware already confines
 * clients to /portal/*; this page just belt-and-suspenders the login check).
 * Visible to the whole internal team — no role gate.
 */
export default async function HandbookPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <AppShell>
      <iframe
        title="SNAP Bookkeeper Handbook"
        srcDoc={BOOKKEEPER_HANDBOOK_HTML}
        className="w-full h-screen border-0"
      />
    </AppShell>
  );
}
