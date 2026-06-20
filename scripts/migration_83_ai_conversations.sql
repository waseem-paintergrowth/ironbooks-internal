-- Migration 83: persist portal "Ask AI" conversations
--
-- Adds two tables so clients can review past questions + answers when they
-- return to the portal. Writes go through the service role (the ask-ai route),
-- scoped per portal user in code; RLS is enabled with no public policies so
-- the anon/auth keys can't read another client's chats.

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references public.client_links(id) on delete cascade,
  user_id uuid not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_idx
  on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
-- No policies: service role bypasses RLS; anon/auth keys get no access.
