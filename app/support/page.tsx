import { AppShell } from "@/components/AppShell";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { SupportClient, type SupportTicket, type Agent } from "./support-client";

export const dynamic = "force-dynamic";

/**
 * /support — in-house support desk (Zendesk-style three-pane workspace).
 * Views rail · ticket list · conversation + client-context panel. Tickets are
 * linked to client_links so an agent sees the client's books beside the thread.
 * Messages are loaded per-ticket on selection (GET /api/support/tickets/[id]).
 */
export default async function SupportPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) redirect("/dashboard");
  const canSend = role !== "viewer";

  // Tickets — newest activity first. (Volume is low; a flat fetch is fine for v1.)
  let tickets: SupportTicket[] = [];
  try {
    const { data } = await (service as any)
      .from("support_tickets")
      .select(
        "id, subject, requester_email, requester_name, client_link_id, status, priority, channel, assignee_id, tags, last_message_at, last_message_preview, last_message_from, created_at"
      )
      .order("last_message_at", { ascending: false })
      .limit(500);
    tickets = (data as SupportTicket[]) || [];
  } catch {
    tickets = []; // table not migrated yet → empty desk
  }

  // Agents (for assignee names + the assignee picker).
  const { data: agentRows } = await service
    .from("users")
    .select("id, full_name, role")
    .in("role", ["admin", "lead", "bookkeeper"])
    .eq("is_active", true);
  const agents: Agent[] = ((agentRows as any[]) || []).map((a) => ({
    id: a.id,
    name: a.full_name || "Agent",
  }));
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  // Client map — link tickets to the client record (name shown; id powers the
  // "open client" link in the context panel).
  const clientIds = [...new Set(tickets.map((t) => t.client_link_id).filter(Boolean))] as string[];
  const clientName = new Map<string, string>();
  if (clientIds.length) {
    const { data: cl } = await service
      .from("client_links")
      .select("id, client_name")
      .in("id", clientIds);
    for (const c of ((cl as any[]) || [])) clientName.set(c.id, c.client_name);
  }

  // Decorate tickets with resolved names.
  const decorated = tickets.map((t) => ({
    ...t,
    assignee_name: t.assignee_id ? agentName.get(t.assignee_id) || null : null,
    client_name: t.client_link_id ? clientName.get(t.client_link_id) || null : null,
  }));

  return (
    <AppShell>
      <SupportClient
        tickets={decorated}
        agents={agents}
        currentUserId={user.id}
        currentUserName={(actor as any)?.full_name || "You"}
        canSend={canSend}
      />
    </AppShell>
  );
}
