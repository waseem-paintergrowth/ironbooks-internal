-- Migration 91 — Support ticketing (in-house, Zendesk-style desk)
-- =========================================================================
-- Email/portal support tickets handled inside SNAP, linked to the client
-- record so an agent sees the client's books right next to the conversation.
-- Inbound-email ingestion (parse webhook → row) lands tickets/messages here;
-- until that's wired, tickets can be created manually or from the portal.
-- RLS on, no policies (service role only — matches the rest of SNAP).
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists support_tickets (
  id                   uuid primary key default gen_random_uuid(),
  subject              text not null,
  requester_email      text not null,
  requester_name       text,
  client_link_id       uuid references client_links(id) on delete set null,
  status               text not null default 'open'    check (status   in ('new','open','pending','solved','closed')),
  priority             text not null default 'normal'  check (priority in ('low','normal','high','urgent')),
  channel              text not null default 'email'   check (channel  in ('email','portal','manual')),
  assignee_id          uuid references users(id) on delete set null,
  tags                 text[] not null default '{}',
  last_message_at      timestamptz not null default now(),
  last_message_preview text,
  last_message_from    text not null default 'customer' check (last_message_from in ('customer','agent')),
  created_by           uuid references users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists support_tickets_status_idx    on support_tickets (status, last_message_at desc);
create index if not exists support_tickets_assignee_idx  on support_tickets (assignee_id);
create index if not exists support_tickets_client_idx    on support_tickets (client_link_id);
create index if not exists support_tickets_requester_idx on support_tickets (lower(requester_email));

alter table support_tickets enable row level security;

create table if not exists support_ticket_messages (
  id               uuid primary key default gen_random_uuid(),
  ticket_id        uuid not null references support_tickets(id) on delete cascade,
  author_type      text not null check (author_type in ('customer','agent','system')),
  author_id        uuid references users(id) on delete set null,   -- the agent, when author_type='agent'
  author_name      text,
  author_email     text,
  body_text        text not null default '',
  body_html        text,
  is_internal      boolean not null default false,                 -- internal note (team-only) vs public reply
  email_message_id text,                                           -- inbound/outbound Message-ID for email threading
  created_at       timestamptz not null default now()
);
create index if not exists support_ticket_messages_ticket_idx on support_ticket_messages (ticket_id, created_at);

alter table support_ticket_messages enable row level security;

-- ── OPTIONAL demo data ───────────────────────────────────────────────────
-- Uncomment to populate the board with a few sample tickets so you can see
-- the layout immediately. Safe to delete later:
--   delete from support_tickets where subject like '[demo]%';
--
-- do $$
-- declare t1 uuid; t2 uuid; t3 uuid;
-- begin
--   insert into support_tickets (subject, requester_email, requester_name, status, priority, channel, last_message_preview, last_message_from)
--   values ('[demo] Can''t log in to the new portal', 'sonny@zunopainting.com', 'Sonny (Zuno Painting)', 'open', 'high', 'email',
--           'I keep getting "Signups not allowed" when I try the magic link...', 'customer') returning id into t1;
--   insert into support_tickets (subject, requester_email, requester_name, status, priority, channel, last_message_preview, last_message_from)
--   values ('[demo] Where is my October statement?', 'amy@brightcoatpro.com', 'Amy (Bright Coat Pro)', 'pending', 'normal', 'email',
--           'We replied asking which account — waiting on the client.', 'agent') returning id into t2;
--   insert into support_tickets (subject, requester_email, requester_name, status, priority, channel, last_message_preview, last_message_from)
--   values ('[demo] Question about a categorized expense', 'dave@summitfinishes.com', 'Dave (Summit Finishes)', 'new', 'low', 'portal',
--           'Why is the Home Depot charge under Materials and not Tools?', 'customer') returning id into t3;
--   insert into support_ticket_messages (ticket_id, author_type, author_name, author_email, body_text) values
--     (t1, 'customer', 'Sonny', 'sonny@zunopainting.com', 'I keep getting "Signups not allowed" when I try the magic link. Can you help?'),
--     (t2, 'customer', 'Amy', 'amy@brightcoatpro.com', 'Where is my October statement? I don''t see it in the portal.'),
--     (t2, 'agent',    'Support', 'admin@ironbooks.com', 'Hi Amy — which bank account is that statement for? We''ll pull it.'),
--     (t3, 'customer', 'Dave', 'dave@summitfinishes.com', 'Why is the Home Depot charge under Materials and not Tools?');
-- end $$;
