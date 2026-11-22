create table if not exists public.telegram_links (
  chat_id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;
revoke all on public.telegram_links from anon, authenticated;
grant all on public.telegram_links to service_role;

create unique index if not exists telegram_links_chat_id_uidx
  on public.telegram_links (chat_id);

create table if not exists public.telegram_link_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.telegram_link_tokens enable row level security;
revoke all on public.telegram_link_tokens from anon, authenticated;
grant all on public.telegram_link_tokens to service_role;

create index if not exists telegram_link_tokens_expires_at_idx
  on public.telegram_link_tokens (expires_at);
