-- Fuel by Buzah — v2: customer online ordering
-- Run AFTER schema.sql. Safe to re-run. Non-destructive: existing orders
-- become status 'confirmed', source 'manager'.
--
-- Security model for the public ordering page:
--   * Customers (anonymous) can NOT read or write any table directly.
--   * They can only call two functions:
--       get_shop(slug)            → public menu + pricing + payment handles
--       place_order(slug, order)  → validates, re-prices on the server, and
--                                   inserts a PENDING order for the owner to approve
--   * Prices, fees, the order window and customer matching are all computed
--     here in the database, so a tampered browser can't change the total.

-- ---------- Orders: approval status, payment, contact snapshot ----------

alter table public.orders
  add column if not exists status         text    not null default 'confirmed',
  add column if not exists source         text    not null default 'manager',
  add column if not exists payment_method text    not null default '',
  add column if not exists paid           boolean not null default false,
  add column if not exists quoted_total   numeric(10, 2),
  add column if not exists contact        jsonb   not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table public.orders add constraint orders_status_check check (status in ('pending', 'confirmed', 'declined'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_source_check') then
    alter table public.orders add constraint orders_source_check check (source in ('manager', 'online'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_method_check') then
    alter table public.orders add constraint orders_payment_method_check check (payment_method in ('', 'cash', 'cashapp', 'zelle'));
  end if;
end $$;

create index if not exists orders_status_idx on public.orders (owner_id, status);

-- Match returning customers by phone number regardless of formatting.
alter table public.customers
  add column if not exists phone_digits text generated always as (regexp_replace(phone, '\D', '', 'g')) stored;
create index if not exists customers_phone_idx on public.customers (owner_id, phone_digits);

-- ---------- Shops: your public ordering link (order.html?shop=<slug>) ----------

create table if not exists public.shops (
  owner_id   uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  created_at timestamptz not null default now()
);

alter table public.shops enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shops' and policyname = 'owner_full_access') then
    create policy owner_full_access on public.shops for all to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;
end $$;

grant select, insert, update, delete on public.shops to authenticated;
revoke all on public.shops from anon;

-- ---------- Private helpers (not reachable through the public API) ----------

create schema if not exists fuel_private;
revoke all on schema fuel_private from public, anon, authenticated;

-- Same rules as js/logic.js orderWindow(): Mon–Thu open; Friday late fee or
-- next week; Sat/Sun roll to next week. Weeks run Monday → Sunday.
create or replace function fuel_private.order_window(p_today date, p_late_orders text, p_late_fee numeric)
returns table (window_status text, week_of date, late_fee numeric)
language sql
immutable
set search_path = ''
as $$
  select
    case when d between 1 and 4 then 'open'
         when d = 5 and p_late_orders = 'fee' then 'late'
         else 'closed' end,
    case when d between 1 and 4 or (d = 5 and p_late_orders = 'fee') then ws else ws + 7 end,
    case when d = 5 and p_late_orders = 'fee' then round(coalesce(p_late_fee, 0), 2) else 0 end
  from (select extract(isodow from p_today)::int as d, p_today - (extract(isodow from p_today)::int - 1) as ws) x;
$$;

-- ---------- get_shop: what the public ordering page is allowed to see ----------

create or replace function public.get_shop(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_s     jsonb;
  v_tz    text;
begin
  select owner_id into v_owner from public.shops where slug = lower(trim(p_slug));
  if v_owner is null then
    return null;
  end if;

  select data into v_s from public.settings where owner_id = v_owner;
  v_s  := coalesce(v_s, '{}'::jsonb);
  v_tz := coalesce(nullif(v_s ->> 'timezone', ''), 'America/Chicago');

  return jsonb_build_object(
    'slug',         lower(trim(p_slug)),
    'businessName', coalesce(nullif(v_s ->> 'businessName', ''), 'Fuel by Buzah'),
    'tagline',      coalesce(v_s ->> 'tagline', ''),
    'today',        (now() at time zone v_tz)::date,
    'settings', jsonb_build_object(
      'deliveryFee',       coalesce((v_s ->> 'deliveryFee')::numeric, 0),
      'pickupDiscountPct', coalesce((v_s ->> 'pickupDiscountPct')::numeric, 0),
      'taxRatePct',        coalesce((v_s ->> 'taxRatePct')::numeric, 0),
      'lateOrders',        coalesce(v_s ->> 'lateOrders', 'fee'),
      'lateFee',           coalesce((v_s ->> 'lateFee')::numeric, 0),
      'macroDays',         coalesce((v_s ->> 'macroDays')::int, 5),
      'orderingOpen',      coalesce((v_s ->> 'orderingOpen')::boolean, true),
      'acceptCash',        coalesce((v_s ->> 'acceptCash')::boolean, true),
      'cashApp',           coalesce(v_s ->> 'cashApp', ''),
      'zelle',             coalesce(v_s ->> 'zelle', '')
    ),
    -- Only what a customer needs: no ingredients, no inactive meals.
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'price', m.price, 'macros', m.macros) order by m.created_at)
      from public.meals m
      where m.owner_id = v_owner and m.active
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------- place_order: validate, price, match customer, insert PENDING ----------

create or replace function public.place_order(p_slug text, p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner       uuid;
  v_s           jsonb;
  v_tz          text;
  v_today       date;
  v_week        date;
  v_late        numeric := 0;
  v_window      text;

  v_name        text := left(trim(coalesce(p_order ->> 'name', '')), 100);
  v_phone       text := left(trim(coalesce(p_order ->> 'phone', '')), 30);
  v_digits      text;
  v_address     text := left(trim(coalesce(p_order ->> 'address', '')), 200);
  v_fulfillment text := coalesce(p_order ->> 'fulfillment', '');
  v_payment     text := coalesce(p_order ->> 'paymentMethod', '');
  v_notes       text := left(trim(coalesce(p_order ->> 'notes', '')), 500);
  v_items       jsonb := p_order -> 'items';

  v_item        jsonb;
  v_clean       jsonb := '[]'::jsonb;
  v_seen        text[] := '{}';
  v_meal_id     text;
  v_qty         int;
  v_price       numeric;
  v_total_qty   int := 0;

  v_subtotal    numeric := 0;
  v_discount    numeric := 0;
  v_taxable     numeric;
  v_tax         numeric;
  v_delivery    numeric := 0;
  v_total       numeric;

  v_targets     jsonb := '{}'::jsonb;
  v_key         text;
  v_val         numeric;

  v_cust        record;
  v_customer_id text;
  v_order_id    text;
  v_count       int;
begin
  -- Shop
  select owner_id into v_owner from public.shops where slug = lower(trim(p_slug));
  if v_owner is null then
    raise exception 'This ordering link is not valid.';
  end if;
  select data into v_s from public.settings where owner_id = v_owner;
  v_s := coalesce(v_s, '{}'::jsonb);
  if not coalesce((v_s ->> 'orderingOpen')::boolean, true) then
    raise exception 'Online ordering is closed right now.';
  end if;

  -- Contact
  if length(v_name) < 2 then
    raise exception 'Please enter your name.';
  end if;
  v_digits := regexp_replace(v_phone, '\D', '', 'g');
  if length(v_digits) = 11 and left(v_digits, 1) = '1' then
    v_digits := substr(v_digits, 2);
  end if;
  if length(v_digits) <> 10 then
    raise exception 'Please enter a 10-digit phone number.';
  end if;
  if v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Choose delivery or pickup.';
  end if;
  if v_fulfillment = 'delivery' and length(v_address) < 5 then
    raise exception 'Please enter a delivery address.';
  end if;

  -- Payment method must be one the owner accepts
  if v_payment = 'cash' and not coalesce((v_s ->> 'acceptCash')::boolean, true)
     or v_payment = 'cashapp' and coalesce(v_s ->> 'cashApp', '') = ''
     or v_payment = 'zelle' and coalesce(v_s ->> 'zelle', '') = ''
     or v_payment not in ('cash', 'cashapp', 'zelle') then
    raise exception 'Choose a payment method.';
  end if;

  -- Items: 1–30 distinct active meals, whole quantities 1–50, max 60 meals total
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Add at least one meal.';
  end if;
  if jsonb_array_length(v_items) > 30 then
    raise exception 'Too many different meals in one order.';
  end if;
  for v_item in select * from jsonb_array_elements(v_items) loop
    v_meal_id := v_item ->> 'mealId';
    if coalesce(v_item ->> 'qty', '') !~ '^[0-9]{1,3}$' then
      raise exception 'Meal quantities must be whole numbers.';
    end if;
    v_qty := (v_item ->> 'qty')::int;
    if v_qty < 1 or v_qty > 50 then
      raise exception 'Each meal quantity must be between 1 and 50.';
    end if;
    if v_meal_id = any (v_seen) then
      raise exception 'The same meal is listed twice.';
    end if;
    v_seen := v_seen || v_meal_id;
    select m.price into v_price from public.meals m where m.owner_id = v_owner and m.id = v_meal_id and m.active;
    if not found then
      raise exception 'One of the meals is no longer on the menu. Please refresh the page.';
    end if;
    v_total_qty := v_total_qty + v_qty;
    v_subtotal  := v_subtotal + round(v_price * v_qty, 2);
    v_clean     := v_clean || jsonb_build_object('mealId', v_meal_id, 'qty', v_qty);
  end loop;
  if v_total_qty > 60 then
    raise exception 'Orders are limited to 60 meals. Please contact us for bigger orders.';
  end if;

  -- Optional daily macro goals
  if jsonb_typeof(p_order -> 'targets') = 'object' then
    foreach v_key in array array['cal', 'protein', 'carbs', 'fat'] loop
      if coalesce(p_order -> 'targets' ->> v_key, '') ~ '^[0-9]{1,5}(\.[0-9]+)?$' then
        v_val := (p_order -> 'targets' ->> v_key)::numeric;
        if v_val > 0 and v_val <= 20000 then
          v_targets := v_targets || jsonb_build_object(v_key, round(v_val));
        end if;
      end if;
    end loop;
  end if;

  -- Spam guards
  select count(*) into v_count from public.orders
   where owner_id = v_owner and status = 'pending' and contact ->> 'phoneDigits' = v_digits;
  if v_count >= 3 then
    raise exception 'You already have orders waiting for confirmation. We''ll be in touch soon!';
  end if;
  select count(*) into v_count from public.orders where owner_id = v_owner and status = 'pending';
  if v_count >= 100 then
    raise exception 'We''re not taking more online orders right now. Please contact us directly.';
  end if;

  -- Order window (same rules as js/logic.js orderWindow), in the shop's time zone
  v_tz    := coalesce(nullif(v_s ->> 'timezone', ''), 'America/Chicago');
  v_today := (now() at time zone v_tz)::date;
  select w.window_status, w.week_of, w.late_fee into v_window, v_week, v_late
    from fuel_private.order_window(v_today, coalesce(v_s ->> 'lateOrders', 'fee'), (v_s ->> 'lateFee')::numeric) w;

  -- Pricing (same rules as js/logic.js orderTotals)
  if v_fulfillment = 'pickup' then
    v_discount := round(v_subtotal * coalesce((v_s ->> 'pickupDiscountPct')::numeric, 0) / 100, 2);
  end if;
  v_taxable := v_subtotal - v_discount;
  v_tax     := round(v_taxable * coalesce((v_s ->> 'taxRatePct')::numeric, 0) / 100, 2);
  if v_fulfillment = 'delivery' then
    v_delivery := round(coalesce((v_s ->> 'deliveryFee')::numeric, 0), 2);
  end if;
  v_total := v_taxable + v_tax + v_delivery + v_late;

  -- Match a returning customer by phone, or create a new one.
  -- Existing customer details are never overwritten by the public form;
  -- we only fill in blanks. What they typed is kept on the order (contact).
  select c.id, c.address, c.targets into v_cust
    from public.customers c
   where c.owner_id = v_owner and c.phone_digits in (v_digits, '1' || v_digits)
   order by c.created_at
   limit 1;

  if not found then
    v_customer_id := 'cust_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    insert into public.customers (owner_id, id, name, phone, address, targets)
    values (v_owner, v_customer_id, v_name, v_phone, case when v_fulfillment = 'delivery' then v_address else '' end, v_targets);
  else
    v_customer_id := v_cust.id;
    update public.customers c
       set address = case when coalesce(c.address, '') = '' and v_fulfillment = 'delivery' then v_address else c.address end,
           targets = case when not exists (select 1 from jsonb_each_text(c.targets) t where t.value ~ '^[0-9.]+$' and t.value::numeric > 0)
                               and v_targets <> '{}'::jsonb
                          then v_targets else c.targets end
     where c.owner_id = v_owner and c.id = v_customer_id;
  end if;

  v_order_id := 'web_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.orders (owner_id, id, customer_id, created_on, week_of, items, fulfillment, notes,
                             late_fee, status, source, payment_method, paid, quoted_total, contact)
  values (v_owner, v_order_id, v_customer_id, v_today, v_week, v_clean, v_fulfillment, v_notes,
          v_late, 'pending', 'online', v_payment, false, v_total,
          jsonb_build_object('name', v_name, 'phone', v_phone, 'phoneDigits', v_digits, 'address', v_address, 'targets', v_targets));

  return jsonb_build_object(
    'orderId',      v_order_id,
    'ref',          upper(right(v_order_id, 6)),
    'status',       'pending',
    'window',       v_window,
    'weekOf',       v_week,
    'deliveryDay',  v_week + 6,
    'mealCount',    v_total_qty,
    'subtotal',     v_subtotal,
    'discount',     v_discount,
    'tax',          v_tax,
    'deliveryFee',  v_delivery,
    'lateFee',      v_late,
    'total',        v_total,
    'paymentMethod', v_payment,
    'cashApp',      coalesce(v_s ->> 'cashApp', ''),
    'zelle',        coalesce(v_s ->> 'zelle', ''),
    'businessName', coalesce(nullif(v_s ->> 'businessName', ''), 'Fuel by Buzah')
  );
end;
$$;

-- Only these two functions are reachable by the public.
revoke all on function public.get_shop(text) from public;
revoke all on function public.place_order(text, jsonb) from public;
grant execute on function public.get_shop(text) to anon, authenticated;
grant execute on function public.place_order(text, jsonb) to anon, authenticated;
