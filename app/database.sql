-- Skala: база заявок, внутреннего чата и файлов.
-- Выполните этот файл один раз в Supabase SQL Editor от имени владельца проекта.
-- Скрипт не полагается на "Automatically expose new tables": права Data API
-- для anon/authenticated задаются явно ниже.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 160),
  phone text not null default '' check (char_length(phone) <= 80),
  role text not null default 'client' check (role in ('client', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  display_id text not null unique check (char_length(display_id) between 1 and 80),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_name text not null check (char_length(contact_name) between 1 and 160),
  phone text not null check (char_length(phone) between 1 and 80),
  email text not null default '' check (char_length(email) <= 320),
  project_type text not null check (char_length(project_type) between 1 and 160),
  budget text not null default 'Пока не определён' check (char_length(budget) <= 160),
  idea text not null check (char_length(idea) between 1 and 20000),
  deadline date,
  reference_url text not null default '' check (char_length(reference_url) <= 2048),
  styles text[] not null default '{}',
  status text not null default 'На обсуждении' check (char_length(status) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid references public.requests(id) on delete set null,
  body text not null default '' check (char_length(body) <= 4000),
  kind text not null default 'text' check (kind in ('text', 'system', 'file')),
  attachment_path text check (attachment_path is null or char_length(attachment_path) <= 1024),
  attachment_name text check (attachment_name is null or char_length(attachment_name) <= 255),
  created_at timestamptz not null default now(),
  constraint messages_file_fields check (
    (kind = 'file' and attachment_path is not null and attachment_name is not null)
    or (kind <> 'file' and attachment_path is null and attachment_name is null)
  )
);

create table if not exists public.request_files (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) <= 1024),
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text not null default 'application/octet-stream' check (char_length(content_type) <= 255),
  size_bytes bigint not null default 0 check (size_bytes between 0 and 10485760),
  created_at timestamptz not null default now()
);

create index if not exists requests_user_created_idx
  on public.requests (user_id, created_at desc);
create index if not exists messages_client_created_idx
  on public.messages (client_id, created_at);
create index if not exists messages_request_idx
  on public.messages (request_id) where request_id is not null;
create index if not exists request_files_request_idx
  on public.request_files (request_id, created_at);
create index if not exists request_files_owner_idx
  on public.request_files (owner_id);

-- SECURITY DEFINER нужен, чтобы проверка роли не зациклилась на RLS profiles.
-- Все имена объектов квалифицированы, а небезопасный search_path отключён.
create or replace function public.is_skala_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = (select auth.uid())
      and profile.role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 160),
    left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 80)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists requests_set_updated_at on public.requests;
create trigger requests_set_updated_at
  before update on public.requests
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.requests enable row level security;
alter table public.messages enable row level security;
alter table public.request_files enable row level security;

drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read"
on public.profiles for select to authenticated
using (id = (select auth.uid()) or public.is_skala_admin());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "requests_read" on public.requests;
create policy "requests_read"
on public.requests for select to authenticated
using (user_id = (select auth.uid()) or public.is_skala_admin());

drop policy if exists "requests_create" on public.requests;
create policy "requests_create"
on public.requests for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "requests_admin_update" on public.requests;
create policy "requests_admin_update"
on public.requests for update to authenticated
using (public.is_skala_admin())
with check (public.is_skala_admin());

drop policy if exists "messages_read" on public.messages;
create policy "messages_read"
on public.messages for select to authenticated
using (client_id = (select auth.uid()) or public.is_skala_admin());

drop policy if exists "messages_create" on public.messages;
create policy "messages_create"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and (
    public.is_skala_admin()
    or (
      client_id = (select auth.uid())
      and (
        request_id is null
        or exists (
          select 1
          from public.requests as request
          where request.id = messages.request_id
            and request.user_id = (select auth.uid())
        )
      )
      and (
        attachment_path is null
        or attachment_path like (select auth.uid())::text || '/%'
      )
    )
  )
);

drop policy if exists "request_files_read" on public.request_files;
create policy "request_files_read"
on public.request_files for select to authenticated
using (owner_id = (select auth.uid()) or public.is_skala_admin());

drop policy if exists "request_files_create" on public.request_files;
create policy "request_files_create"
on public.request_files for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and storage_path like (select auth.uid())::text || '/%'
  and exists (
    select 1
    from public.requests as request
    where request.id = request_files.request_id
      and request.user_id = (select auth.uid())
  )
);

-- Права PostgREST/Data API. Сначала снимаем возможные старые grants, затем
-- выдаём authenticated только те операции и столбцы, которые нужны клиенту.
grant usage on schema public to authenticated;

revoke all privileges on table public.profiles from public, anon, authenticated;
revoke all privileges on table public.requests from public, anon, authenticated;
revoke all privileges on table public.messages from public, anon, authenticated;
revoke all privileges on table public.request_files from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (full_name, phone) on table public.profiles to authenticated;

grant select, insert on table public.requests to authenticated;
grant update (status) on table public.requests to authenticated;

grant select, insert on table public.messages to authenticated;
grant select, insert on table public.request_files to authenticated;

-- Функции по умолчанию исполняемы PUBLIC, поэтому закрываем триггерные функции
-- и открываем authenticated только безопасную проверку роли.
revoke all privileges on function public.is_skala_admin() from public, anon, authenticated;
revoke all privileges on function public.handle_new_user() from public, anon, authenticated;
revoke all privileges on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.is_skala_admin() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('skala-files', 'skala-files', false, 10485760)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "storage_read_skala" on storage.objects;
create policy "storage_read_skala"
on storage.objects for select to authenticated
using (
  bucket_id = 'skala-files'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_skala_admin()
  )
);

drop policy if exists "storage_upload_own" on storage.objects;
create policy "storage_upload_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'skala-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Нужна только для безопасной очистки объекта, если запись сообщения/метаданных
-- завершилась ошибкой. Удалять можно исключительно из своей папки bucket.
drop policy if exists "storage_delete_own" on storage.objects;
create policy "storage_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'skala-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Postgres Changes для новых сообщений. SELECT grant и RLS выше определяют,
-- какие события конкретный JWT вправе получить.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end;
$$;

-- После регистрации владельца Skala выполните отдельно в SQL Editor,
-- подставив его email. Через клиентский API изменить role невозможно:
-- update public.profiles set role = 'admin'
-- where id = (select id from auth.users where email = 'owner@example.com');
