-- Выполните один раз: Supabase → SQL Editor → New query → вставить → Run
create table if not exists bot_state (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
-- Защита: включаем RLS без политик, чтобы публичный (anon) ключ не мог читать данные.
-- Бот работает с секретным ключом service_role, для него RLS не мешает.
alter table bot_state enable row level security;
