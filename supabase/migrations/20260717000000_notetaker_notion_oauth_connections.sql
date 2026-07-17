-- Winday Meet (notetaker) — per-user Notion OAuth connections.
-- Tokens are SERVICE-ROLE ONLY: RLS is enabled with no policies, so the
-- browser/anon/authenticated roles can never read the access_token. All access
-- goes through the notion-oauth / export-notion edge functions (service role).

create table if not exists public.notion_connections (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  access_token    text not null,
  bot_id          text,
  workspace_id    text,
  workspace_name  text,
  workspace_icon  text,
  database_id     text,
  database_url    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.notion_connections enable row level security;
-- (intentionally no policies — service role bypasses RLS; everyone else denied)

-- Short-lived CSRF/state nonces for the OAuth round-trip (state -> user_id).
create table if not exists public.notion_oauth_states (
  state       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.notion_oauth_states enable row level security;
-- (intentionally no policies — service role only)

comment on table public.notion_connections is 'Winday Meet: per-user Notion OAuth tokens + auto-created database. Service-role only.';
comment on table public.notion_oauth_states is 'Winday Meet: short-lived OAuth state nonces mapping state -> user_id.';
