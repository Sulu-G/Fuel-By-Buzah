-- Fuel by Buzah — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it only creates things that don't exist yet.
--
-- Security model: every row belongs to the signed-in user (owner_id).
-- Row Level Security (RLS) means the public "publishable/anon" key in the
-- front-end can only ever read or write the logged-in owner's own rows.

-- ---------- Tables ----------

create table if not exists public.settings (
  owner_id   uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.meals (
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id          text not null,
  name        text not null check (length(trim(name)) > 0),
  price       numeric(10, 2) not null check (price > 0),
  macros      jsonb not null default '{}'::jsonb,
  ingredients jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.customers (
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  name       text not null check (length(trim(name)) > 0),
  phone      text not null default '',
  address    text not null default '',
  targets    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.orders (
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id          text not null,
  customer_id text not null,
  created_on  date not null,
  week_of     date not null,
  items       jsonb not null default '[]'::jsonb,
  fulfillment text not null check (fulfillment in ('delivery', 'pickup')),
  notes       text not null default '',
  late_fee    numeric(10, 2) not null default 0 check (late_fee >= 0),
  created_at  timestamptz not null default now(),
  primary key (owner_id, id),
  -- An order can't point at a customer that doesn't exist (or belongs to someone else).
  foreign key (owner_id, customer_id) references public.customers (owner_id, id) on delete restrict
);

create index if not exists orders_week_idx on public.orders (owner_id, week_of);
create index if not exists orders_customer_idx on public.orders (owner_id, customer_id);

-- ---------- Row Level Security: owner-only access ----------

alter table public.settings  enable row level security;
alter table public.meals     enable row level security;
alter table public.customers enable row level security;
alter table public.orders    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings', 'meals', 'customers', 'orders'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'owner_full_access') then
      execute format(
        'create policy owner_full_access on public.%I for all to authenticated
           using (owner_id = (select auth.uid()))
           with check (owner_id = (select auth.uid()))', t);
    end if;
  end loop;
end $$;

grant select, insert, update, delete on public.settings, public.meals, public.customers, public.orders to authenticated;
revoke all on public.settings, public.meals, public.customers, public.orders from anon;

-- ---------- Realtime: live sync between your phone and laptop ----------

do $$
declare t text;
begin
  foreach t in array array['settings', 'meals', 'customers', 'orders'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
