"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  LifeBuoy, Plus, Send, StickyNote, ExternalLink, Building2, Mail,
  Loader2, ChevronDown, Inbox as InboxIcon, X,
} from "lucide-react";

export type SupportTicket = {
  id: string;
  subject: string;
  requester_email: string;
  requester_name: string | null;
  client_link_id: string | null;
  status: "new" | "open" | "pending" | "solved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  channel: "email" | "portal" | "manual";
  assignee_id: string | null;
  tags: string[];
  last_message_at: string;
  last_message_preview: string | null;
  last_message_from: "customer" | "agent";
  created_at: string;
  assignee_name?: string | null;
  client_name?: string | null;
};

export type Agent = { id: string; name: string };

type Message = {
  id: string;
  author_type: "customer" | "agent" | "system";
  author_name: string | null;
  author_email: string | null;
  body_text: string;
  is_internal: boolean;
  created_at: string;
};

const UNSOLVED = new Set(["new", "open", "pending"]);

// Starter canned replies (the "snippets" / macro analog). KB-grounded AI
// drafting plugs in here next — see /support follow-up.
const SNIPPETS: { label: string; text: string }[] = [
  { label: "Acknowledge", text: "Thanks for reaching out — we've got this and will follow up shortly." },
  { label: "Need info", text: "Happy to help! Could you confirm the email address your Ironbooks invite was sent to?" },
  { label: "Resolved", text: "This should be sorted now. Let us know if anything still looks off — happy to help." },
];

function ago(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_STYLE: Record<SupportTicket["status"], string> = {
  new: "bg-blue-100 text-blue-700",
  open: "bg-red-100 text-red-700",
  pending: "bg-amber-100 text-amber-700",
  solved: "bg-green-100 text-green-700",
  closed: "bg-gray-100 text-gray-500",
};
const PRIORITY_DOT: Record<SupportTicket["priority"], string> = {
  urgent: "bg-red-500",
  high: "bg-orange-400",
  normal: "bg-slate-300",
  low: "bg-gray-200",
};

export function SupportClient({
  tickets: initial,
  agents,
  currentUserId,
  currentUserName,
  canSend,
}: {
  tickets: SupportTicket[];
  agents: Agent[];
  currentUserId: string;
  currentUserName: string;
  canSend: boolean;
}) {
  const [tickets, setTickets] = useState<SupportTicket[]>(initial);
  const [view, setView] = useState<string>("all_unsolved");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const selected = tickets.find((t) => t.id === selectedId) || null;

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all_unsolved: 0, mine: 0, unassigned: 0, open: 0, pending: 0, new: 0, solved: 0,
    };
    for (const t of tickets) {
      if (UNSOLVED.has(t.status)) {
        c.all_unsolved++;
        if (t.assignee_id === currentUserId) c.mine++;
        if (!t.assignee_id) c.unassigned++;
      }
      if (t.status === "open") c.open++;
      if (t.status === "pending") c.pending++;
      if (t.status === "new") c.new++;
      if (t.status === "solved") c.solved++;
    }
    return c;
  }, [tickets, currentUserId]);

  const visible = useMemo(() => {
    const f = (t: SupportTicket) => {
      switch (view) {
        case "all_unsolved": return UNSOLVED.has(t.status);
        case "mine": return UNSOLVED.has(t.status) && t.assignee_id === currentUserId;
        case "unassigned": return UNSOLVED.has(t.status) && !t.assignee_id;
        case "open": return t.status === "open";
        case "pending": return t.status === "pending";
        case "new": return t.status === "new";
        case "solved": return t.status === "solved";
        default: return true;
      }
    };
    return tickets.filter(f);
  }, [tickets, view, currentUserId]);

  async function selectTicket(id: string) {
    setSelectedId(id);
    setMessages([]);
    setLoadingMsgs(true);
    try {
      const res = await fetch(`/api/support/tickets/${id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } finally {
      setLoadingMsgs(false);
    }
  }

  function patchTicket(id: string, patch: Partial<SupportTicket>) {
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function updateField(field: "status" | "priority" | "assignee_id", value: string | null) {
    if (!selected) return;
    const patch: any = { [field]: value };
    if (field === "assignee_id") patch.assignee_name = agents.find((a) => a.id === value)?.name || null;
    patchTicket(selected.id, patch);
    await fetch(`/api/support/tickets/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2.5">
          <LifeBuoy size={20} className="text-teal" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-navy" style={{ letterSpacing: "-0.02em" }}>Support</h1>
            <p className="text-xs text-ink-slate">Tickets from email & the portal — answered next to the client's books</p>
          </div>
        </div>
        {canSend && (
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3.5 py-2 transition-colors"
          >
            <Plus size={16} /> New ticket
          </button>
        )}
      </header>

      {/* Workspace */}
      <div className="flex flex-1 min-h-0">
        {/* Views rail */}
        <aside className="w-52 shrink-0 bg-white border-r border-gray-200 overflow-y-auto py-3">
          <div className="px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-light">Views</div>
          <ViewItem label="All unsolved" count={counts.all_unsolved} active={view === "all_unsolved"} onClick={() => setView("all_unsolved")} />
          <ViewItem label="Your unsolved" count={counts.mine} active={view === "mine"} onClick={() => setView("mine")} />
          <ViewItem label="Unassigned" count={counts.unassigned} active={view === "unassigned"} onClick={() => setView("unassigned")} />
          <div className="px-3 mt-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-light">By status</div>
          <ViewItem label="New" count={counts.new} active={view === "new"} onClick={() => setView("new")} />
          <ViewItem label="Open" count={counts.open} active={view === "open"} onClick={() => setView("open")} />
          <ViewItem label="Pending" count={counts.pending} active={view === "pending"} onClick={() => setView("pending")} />
          <ViewItem label="Solved" count={counts.solved} active={view === "solved"} onClick={() => setView("solved")} />
        </aside>

        {/* Ticket list */}
        <div className="w-96 shrink-0 bg-white border-r border-gray-200 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 text-ink-light">
              <InboxIcon size={28} className="mb-2 opacity-40" />
              <p className="text-sm">No tickets in this view.</p>
            </div>
          ) : (
            visible.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTicket(t.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                  selectedId === t.id ? "bg-teal-lighter" : "hover:bg-gray-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${PRIORITY_DOT[t.priority]}`} title={`Priority: ${t.priority}`} />
                  <span className="text-sm font-semibold text-navy truncate flex-1">{t.requester_name || t.requester_email}</span>
                  <span className="text-[11px] text-ink-light shrink-0">{ago(t.last_message_at)}</span>
                </div>
                <div className="text-sm text-navy/90 truncate mt-0.5">{t.subject}</div>
                <div className="text-xs text-ink-slate truncate mt-0.5">
                  {t.last_message_from === "agent" ? "You: " : ""}{t.last_message_preview || ""}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_STYLE[t.status]}`}>{t.status}</span>
                  {t.client_name && (
                    <span className="text-[10px] text-ink-slate inline-flex items-center gap-1 truncate">
                      <Building2 size={10} /> {t.client_name}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Conversation + context */}
        {selected ? (
          <div className="flex flex-1 min-w-0">
            <ConversationPane
              key={selected.id}
              ticket={selected}
              messages={messages}
              loading={loadingMsgs}
              agents={agents}
              canSend={canSend}
              currentUserName={currentUserName}
              onUpdateField={updateField}
              onSent={(m, preview) => {
                setMessages((prev) => [...prev, m]);
                if (!m.is_internal) patchTicket(selected.id, { last_message_preview: preview, last_message_from: "agent", last_message_at: m.created_at });
              }}
            />
            <ClientContextPanel ticket={selected} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-ink-light">
            <LifeBuoy size={40} className="opacity-30 mb-3" />
            <p className="text-sm">Select a ticket to view the conversation.</p>
          </div>
        )}
      </div>

      {showNew && (
        <NewTicketModal
          onClose={() => setShowNew(false)}
          onCreated={(t) => {
            setTickets((prev) => [t, ...prev]);
            setShowNew(false);
            selectTicket(t.id);
          }}
        />
      )}
    </div>
  );
}

function ViewItem({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors ${
        active ? "bg-teal-lighter text-teal-dark font-semibold" : "text-ink-slate hover:bg-gray-50"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`text-[11px] tabular-nums ${active ? "text-teal-dark" : "text-ink-light"}`}>{count}</span>
    </button>
  );
}

function ConversationPane({
  ticket, messages, loading, agents, canSend, currentUserName, onUpdateField, onSent,
}: {
  ticket: SupportTicket;
  messages: Message[];
  loading: boolean;
  agents: Agent[];
  canSend: boolean;
  currentUserName: string;
  onUpdateField: (f: "status" | "priority" | "assignee_id", v: string | null) => void;
  onSent: (m: Message, preview: string) => void;
}) {
  const [body, setBody] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);

  async function send() {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/support/tickets/${ticket.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim(), is_internal: isInternal }),
      });
      if (res.ok) {
        const data = await res.json();
        onSent(data.message, body.trim().slice(0, 120));
        setBody("");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--app-canvas)]">
      {/* Ticket header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-navy truncate">{ticket.subject}</h2>
            <p className="text-xs text-ink-slate mt-0.5 inline-flex items-center gap-1.5">
              <Mail size={12} /> {ticket.requester_name || ticket.requester_email}
              <span className="text-ink-light">· {ticket.channel}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Select value={ticket.status} disabled={!canSend} onChange={(v) => onUpdateField("status", v)}
              options={[["new", "New"], ["open", "Open"], ["pending", "Pending"], ["solved", "Solved"], ["closed", "Closed"]]} />
            <Select value={ticket.priority} disabled={!canSend} onChange={(v) => onUpdateField("priority", v)}
              options={[["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]]} />
            <Select value={ticket.assignee_id || ""} disabled={!canSend} onChange={(v) => onUpdateField("assignee_id", v || null)}
              options={[["", "Unassigned"], ...agents.map((a) => [a.id, a.name] as [string, string])]} />
          </div>
        </div>
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-ink-light text-sm"><Loader2 size={14} className="animate-spin" /> Loading conversation…</div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-ink-light">No messages yet.</p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} m={m} />)
        )}
      </div>

      {/* Composer */}
      {canSend && (
        <div className="bg-white border-t border-gray-200 p-4 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <Toggle active={!isInternal} onClick={() => setIsInternal(false)} label="Public reply" />
            <Toggle active={isInternal} onClick={() => setIsInternal(true)} label="Internal note" icon={<StickyNote size={12} />} />
            <div className="relative ml-auto">
              <button onClick={() => setSnippetsOpen((v) => !v)} className="inline-flex items-center gap-1 text-xs text-ink-slate hover:text-navy px-2 py-1 rounded hover:bg-gray-100">
                Snippets <ChevronDown size={12} />
              </button>
              {snippetsOpen && (
                <div className="absolute right-0 bottom-full mb-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-10">
                  {SNIPPETS.map((s) => (
                    <button key={s.label} onClick={() => { setBody((b) => (b ? b + "\n\n" : "") + s.text); setSnippetsOpen(false); }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">
                      <span className="font-semibold text-navy">{s.label}</span>
                      <span className="block text-ink-light truncate">{s.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={isInternal ? "Add an internal note (team-only)…" : `Reply to ${ticket.requester_name || ticket.requester_email}…`}
            rows={3}
            className={`w-full rounded-lg border px-3 py-2 text-sm outline-none resize-y text-navy ${
              isInternal ? "bg-amber-50 border-amber-200 focus:border-amber-400" : "border-gray-200 focus:border-teal"
            }`}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-ink-light">
              {isInternal ? "Visible to your team only." : "Sends to the customer (email send wires up with inbound ingestion)."}
            </span>
            <button
              onClick={send}
              disabled={!body.trim() || sending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 transition-colors"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {isInternal ? "Add note" : "Send reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ m }: { m: Message }) {
  if (m.author_type === "system") {
    return <div className="text-center text-[11px] text-ink-light py-1">{m.body_text}</div>;
  }
  const isAgent = m.author_type === "agent";
  return (
    <div className={`flex ${isAgent ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[78%] rounded-xl px-4 py-2.5 border ${
        m.is_internal
          ? "bg-amber-50 border-amber-200"
          : isAgent
          ? "bg-teal-lighter border-teal-light"
          : "bg-white border-gray-200"
      }`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-navy">{m.author_name || m.author_email || (isAgent ? "Agent" : "Customer")}</span>
          {m.is_internal && <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 rounded">Internal note</span>}
          <span className="text-[10px] text-ink-light ml-auto">{ago(m.created_at)}</span>
        </div>
        <div className="text-sm text-navy/90 whitespace-pre-wrap leading-relaxed">{m.body_text}</div>
      </div>
    </div>
  );
}

function ClientContextPanel({ ticket }: { ticket: SupportTicket }) {
  return (
    <aside className="w-72 shrink-0 bg-white border-l border-gray-200 overflow-y-auto p-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2">Requester</div>
      <div className="text-sm font-semibold text-navy">{ticket.requester_name || "—"}</div>
      <div className="text-xs text-ink-slate break-all">{ticket.requester_email}</div>

      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2 mt-5">Client</div>
      {ticket.client_link_id ? (
        <div className="rounded-lg border border-gray-200 p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-navy">
            <Building2 size={14} className="text-teal" /> {ticket.client_name || "Linked client"}
          </div>
          <Link href={`/clients/${ticket.client_link_id}`}
            className="inline-flex items-center gap-1 text-xs text-teal-dark hover:underline mt-2">
            Open client record <ExternalLink size={11} />
          </Link>
        </div>
      ) : (
        <p className="text-xs text-ink-light">Not linked to a client yet. Email-to-client matching lands with inbound ingestion.</p>
      )}

      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2 mt-5">Details</div>
      <dl className="text-xs space-y-1.5">
        <Row k="Status" v={ticket.status} />
        <Row k="Priority" v={ticket.priority} />
        <Row k="Channel" v={ticket.channel} />
        <Row k="Assignee" v={ticket.assignee_name || "Unassigned"} />
        <Row k="Opened" v={new Date(ticket.created_at).toLocaleDateString()} />
      </dl>
      {ticket.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {ticket.tags.map((t) => <span key={t} className="text-[10px] bg-gray-100 text-ink-slate px-1.5 py-0.5 rounded">{t}</span>)}
        </div>
      )}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-light">{k}</dt>
      <dd className="text-navy font-medium capitalize text-right">{v}</dd>
    </div>
  );
}

function Select({ value, onChange, options, disabled }: { value: string; onChange: (v: string) => void; options: [string, string][]; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rounded-md border border-gray-200 bg-white px-2 py-1.5 text-navy outline-none focus:border-teal disabled:opacity-60 capitalize"
    >
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

function Toggle({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
        active ? "bg-navy text-white" : "text-ink-slate hover:bg-gray-100"
      }`}
    >
      {icon}{label}
    </button>
  );
}

function NewTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: SupportTicket) => void }) {
  const [subject, setSubject] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!subject.trim() || !email.trim() || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), requester_email: email.trim(), requester_name: name.trim() || null, body: body.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || "Couldn't create ticket."); return; }
      onCreated(data.ticket);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-navy">New ticket</h3>
          <button onClick={onClose} className="text-ink-light hover:text-navy"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} className="field" placeholder="Short summary" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Requester email"><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="field" placeholder="client@company.com" /></Field>
            <Field label="Name (optional)"><input value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="Sonny" /></Field>
          </div>
          <Field label="First message (optional)"><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="field resize-y" placeholder="What's the issue?" /></Field>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm text-ink-slate px-3 py-2 rounded-lg hover:bg-gray-100">Cancel</button>
          <button onClick={create} disabled={!subject.trim() || !email.trim() || saving}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
            {saving && <Loader2 size={14} className="animate-spin" />} Create ticket
          </button>
        </div>
      </div>
      <style jsx>{`
        .field { width: 100%; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; color: #0f1f2e; outline: none; }
        .field:focus { border-color: #2d7a75; }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-navy mb-1">{label}</span>
      {children}
    </label>
  );
}
