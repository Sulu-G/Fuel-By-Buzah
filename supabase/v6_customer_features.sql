-- Fuel by Buzah — v6: order tracking, meal photos & allergens, weekly limits,
-- weekly meal plans. Run AFTER v5. Safe to re-run.
--
--   * meals get a description, allergen tags, a photo and an optional weekly limit
--   * get_shop() shows those, plus how many of each meal are left this week
--   * place_order() enforces weekly limits and can start a weekly meal plan
--   * track_order() lets a customer check an order with their phone + order code
--   * plan_action() lets them pause / resume / skip a week / cancel their plan
--   * every Monday at 6 AM Central, generate_plan_orders() creates that week's
--     plan orders as PENDING for the owner to approve (one push alert summary)
-- (The delivery-area check runs in the manager app, so the kitchen address
--  never leaves the owner's account.)

-- ---------- Meals: details customers see ----------

alter table public.meals add column if not exists description  text not null default '';
alter table public.meals add column if not exists allergens    text[] not null default '{}';
alter table public.meals add column if not exists photo_url    text not null default '';
alter table public.meals add column if not exists weekly_limit int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meals_allergens_check') then
    alter table public.meals add constraint meals_allergens_check
      check (allergens <@ array['milk', 'eggs', 'fish', 'shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soy', 'sesame']);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meals_weekly_limit_check') then
    alter table public.meals add constraint meals_weekly_limit_check check (weekly_limit is null or weekly_limit between 1 and 999);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meals_photo_url_check') then
    alter table public.meals add constraint meals_photo_url_check check (photo_url = '' or photo_url ~ '^(https://|data:image/(jpeg|webp|png);base64,)');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meals_description_check') then
    alter table public.meals add constraint meals_description_check check (length(description) <= 300);
  end if;
end $$;

-- ---------- Meal photos: public bucket, owners write only to their own folder ----------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('meal-photos', 'meal-photos', true, 2097152, array['image/jpeg', 'image/webp', 'image/png'])
    on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/webp', 'image/png'];

    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'meal_photos_owner_insert') then
      create policy meal_photos_owner_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'meal_photos_owner_update') then
      create policy meal_photos_owner_update on storage.objects for update to authenticated
        using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'meal_photos_owner_delete') then
      create policy meal_photos_owner_delete on storage.objects for delete to authenticated
        using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
    end if;
  end if;
end $$;

-- ---------- Weekly meal plans ----------

create table if not exists public.meal_plans (
  owner_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id             text not null,
  customer_id    text not null,
  items          jsonb not null default '[]'::jsonb,
  fulfillment    text not null check (fulfillment in ('delivery', 'pickup')),
  payment_method text not null default '' check (payment_method in ('', 'cash', 'cashapp', 'zelle')),
  notes          text not null default '',
  contact        jsonb not null default '{}'::jsonb,   -- name, phone, phoneDigits, address
  status         text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  skip_weeks     date[] not null default '{}',
  last_week      date,                                 -- latest week that already has an order
  started_from   text,                                 -- the order that started the plan
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, customer_id) references public.customers (owner_id, id) on delete cascade
);

alter table public.meal_plans enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meal_plans' and policyname = 'owner_all') then
    create policy owner_all on public.meal_plans for all to authenticated
      using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
  end if;
end $$;
revoke all on public.meal_plans from anon;
grant select, insert, update, delete on public.meal_plans to authenticated;

alter table public.orders add column if not exists plan_id text;
alter table public.orders drop constraint if exists orders_source_check;
alter table public.orders add constraint orders_source_check check (source in ('manager', 'online', 'plan'));
create index if not exists orders_owner_week_idx on public.orders (owner_id, week_of, status);
create index if not exists meal_plans_customer_idx on public.meal_plans (owner_id, customer_id);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meal_plans') then
    alter publication supabase_realtime add table public.meal_plans;
  end if;
end $$;

-- ---------- Helpers ----------

-- Meals already ordered (pending + confirmed) for a week, by meal id.
create or replace function fuel_private.meals_sold(p_owner uuid, p_week date)
returns table (meal_id text, sold int)
language sql
stable
set search_path = ''
as $$
  select i ->> 'mealId', sum((i ->> 'qty')::int)::int
    from public.orders o, jsonb_array_elements(o.items) i
   where o.owner_id = p_owner and o.week_of = p_week and o.status in ('pending', 'confirmed')
   group by 1;
$$;

-- Validate and price a list of items, enforcing weekly limits (rows are locked,
-- so two customers can't both buy the last meal). Same rules as js/logic.js.
create or replace function fuel_private.price_order(p_owner uuid, p_s jsonb, p_items jsonb, p_fulfillment text, p_late numeric, p_week date)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_clean    jsonb := '[]'::jsonb;
  v_seen     text[] := '{}';
  v_meal_id  text;
  v_qty      int;
  v_meal     record;
  v_sold     int;
  v_left     int;
  v_total_qty int := 0;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_taxable  numeric;
  v_tax      numeric;
  v_delivery numeric := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one meal.';
  end if;
  if jsonb_array_length(p_items) > 30 then
    raise exception 'Too many different meals in one order.';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
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
    select m.name, m.price, m.weekly_limit into v_meal
      from public.meals m where m.owner_id = p_owner and m.id = v_meal_id and m.active
      for update;
    if not found then
      raise exception 'One of the meals is no longer on the menu. Please refresh the page.';
    end if;
    if v_meal.weekly_limit is not null then
      select coalesce(sum((i ->> 'qty')::int), 0) into v_sold
        from public.orders o, jsonb_array_elements(o.items) i
       where o.owner_id = p_owner and o.week_of = p_week and o.status in ('pending', 'confirmed') and i ->> 'mealId' = v_meal_id;
      v_left := greatest(v_meal.weekly_limit - v_sold, 0);
      if v_qty > v_left then
        if v_left = 0 then
          raise exception '% is sold out for this week.', v_meal.name;
        end if;
        raise exception 'Only % % left this week.', v_left, v_meal.name;
      end if;
    end if;
    v_total_qty := v_total_qty + v_qty;
    v_subtotal  := v_subtotal + round(v_meal.price * v_qty, 2);
    v_clean     := v_clean || jsonb_build_object('mealId', v_meal_id, 'qty', v_qty);
  end loop;
  if v_total_qty > 60 then
    raise exception 'Orders are limited to 60 meals. Please contact us for bigger orders.';
  end if;

  if p_fulfillment = 'pickup' then
    v_discount := round(v_subtotal * coalesce((p_s ->> 'pickupDiscountPct')::numeric, 0) / 100, 2);
  end if;
  v_taxable := v_subtotal - v_discount;
  v_tax     := round(v_taxable * coalesce((p_s ->> 'taxRatePct')::numeric, 0) / 100, 2);
  if p_fulfillment = 'delivery' then
    v_delivery := round(coalesce((p_s ->> 'deliveryFee')::numeric, 0), 2);
  end if;
  return jsonb_build_object('items', v_clean, 'mealCount', v_total_qty, 'subtotal', v_subtotal, 'discount', v_discount,
                            'tax', v_tax, 'deliveryFee', v_delivery, 'lateFee', coalesce(p_late, 0),
                            'total', v_taxable + v_tax + v_delivery + coalesce(p_late, 0));
end;
$$;

create or replace function fuel_private.phone_digits(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2) else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

-- ---------- get_shop: now with photos, allergens, ingredients and stock ----------

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
  v_week  date;
begin
  select owner_id into v_owner from public.shops where slug = lower(trim(p_slug));
  if v_owner is null then
    return null;
  end if;

  select data into v_s from public.settings where owner_id = v_owner;
  v_s  := coalesce(v_s, '{}'::jsonb);
  v_tz := coalesce(nullif(v_s ->> 'timezone', ''), 'America/Chicago');
  select w.week_of into v_week
    from fuel_private.order_window((now() at time zone v_tz)::date, coalesce(v_s ->> 'lateOrders', 'fee'), (v_s ->> 'lateFee')::numeric) w;

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
      'zelle',             coalesce(v_s ->> 'zelle', ''),
      'plansEnabled',      coalesce((v_s ->> 'plansEnabled')::boolean, true)
    ),
    -- What a customer needs: ingredient names (no amounts), no inactive meals.
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'price', m.price, 'macros', m.macros,
               'description', m.description, 'allergens', to_jsonb(m.allergens), 'photo', m.photo_url,
               'ingredients', coalesce((select jsonb_agg(distinct lower(trim(i ->> 'item'))) from jsonb_array_elements(m.ingredients) i
                                         where coalesce(trim(i ->> 'item'), '') <> ''), '[]'::jsonb),
               'remaining', case when m.weekly_limit is null then null else greatest(m.weekly_limit - coalesce(s.sold, 0), 0) end)
             order by m.created_at)
      from public.meals m
      left join fuel_private.meals_sold(v_owner, v_week) s on s.meal_id = m.id
      where m.owner_id = v_owner and m.active
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------- place_order: weekly limits + optional weekly plan ----------

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
  v_repeat      boolean := coalesce((p_order ->> 'repeatWeekly')::boolean, false);
  v_price       jsonb;

  v_targets     jsonb := '{}'::jsonb;
  v_key         text;
  v_val         numeric;

  v_cust        record;
  v_customer_id text;
  v_order_id    text;
  v_plan_id     text;
  v_contact     jsonb;
  v_count       int;
begin
  select owner_id into v_owner from public.shops where slug = lower(trim(p_slug));
  if v_owner is null then
    raise exception 'This ordering link is not valid.';
  end if;
  select data into v_s from public.settings where owner_id = v_owner;
  v_s := coalesce(v_s, '{}'::jsonb);
  if not coalesce((v_s ->> 'orderingOpen')::boolean, true) then
    raise exception 'Online ordering is closed right now.';
  end if;

  if length(v_name) < 2 then
    raise exception 'Please enter your name.';
  end if;
  v_digits := fuel_private.phone_digits(v_phone);
  if length(v_digits) <> 10 then
    raise exception 'Please enter a 10-digit phone number.';
  end if;
  if v_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Choose delivery or pickup.';
  end if;
  if v_fulfillment = 'delivery' and length(v_address) < 5 then
    raise exception 'Please enter a delivery address.';
  end if;
  if v_payment = 'cash' and not coalesce((v_s ->> 'acceptCash')::boolean, true)
     or v_payment = 'cashapp' and coalesce(v_s ->> 'cashApp', '') = ''
     or v_payment = 'zelle' and coalesce(v_s ->> 'zelle', '') = ''
     or v_payment not in ('cash', 'cashapp', 'zelle') then
    raise exception 'Choose a payment method.';
  end if;
  if v_repeat and not coalesce((v_s ->> 'plansEnabled')::boolean, true) then
    v_repeat := false;
  end if;

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

  -- Spam guards (weekly-plan orders don't count against the customer)
  select count(*) into v_count from public.orders
   where owner_id = v_owner and status = 'pending' and source = 'online' and contact ->> 'phoneDigits' = v_digits;
  if v_count >= 3 then
    raise exception 'You already have orders waiting for confirmation. We''ll be in touch soon!';
  end if;
  select count(*) into v_count from public.orders where owner_id = v_owner and status = 'pending';
  if v_count >= 100 then
    raise exception 'We''re not taking more online orders right now. Please contact us directly.';
  end if;

  v_tz    := coalesce(nullif(v_s ->> 'timezone', ''), 'America/Chicago');
  v_today := (now() at time zone v_tz)::date;
  select w.window_status, w.week_of, w.late_fee into v_window, v_week, v_late
    from fuel_private.order_window(v_today, coalesce(v_s ->> 'lateOrders', 'fee'), (v_s ->> 'lateFee')::numeric) w;

  v_price := fuel_private.price_order(v_owner, v_s, p_order -> 'items', v_fulfillment, v_late, v_week);

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
  v_contact  := jsonb_build_object('name', v_name, 'phone', v_phone, 'phoneDigits', v_digits, 'address', v_address, 'targets', v_targets);

  if v_repeat then
    -- One active plan per customer: a new one replaces the old.
    update public.meal_plans set status = 'cancelled', updated_at = now()
     where owner_id = v_owner and customer_id = v_customer_id and status <> 'cancelled';
    v_plan_id := 'plan_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    insert into public.meal_plans (owner_id, id, customer_id, items, fulfillment, payment_method, notes, contact, last_week, started_from)
    values (v_owner, v_plan_id, v_customer_id, v_price -> 'items', v_fulfillment, v_payment, v_notes, v_contact, v_week, v_order_id);
  end if;

  insert into public.orders (owner_id, id, customer_id, created_on, week_of, items, fulfillment, notes,
                             late_fee, status, source, payment_method, paid, quoted_total, contact, plan_id)
  values (v_owner, v_order_id, v_customer_id, v_today, v_week, v_price -> 'items', v_fulfillment, v_notes,
          v_late, 'pending', 'online', v_payment, false, (v_price ->> 'total')::numeric, v_contact, v_plan_id);

  return v_price - 'items' || jsonb_build_object(
    'orderId',       v_order_id,
    'ref',           upper(right(v_order_id, 6)),
    'status',        'pending',
    'window',        v_window,
    'weekOf',        v_week,
    'deliveryDay',   v_week + 6,
    'paymentMethod', v_payment,
    'cashApp',       coalesce(v_s ->> 'cashApp', ''),
    'zelle',         coalesce(v_s ->> 'zelle', ''),
    'businessName',  coalesce(nullif(v_s ->> 'businessName', ''), 'Fuel by Buzah'),
    'planId',        v_plan_id
  );
end;
$$;

-- ---------- track_order: phone number + order code ----------

-- Finds an order by its 6-character code, only if the phone number matches.
create or replace function fuel_private.find_order(p_slug text, p_phone text, p_ref text)
returns table (owner_id uuid, order_id text, plan_id text)
language sql
stable
set search_path = ''
as $$
  select o.owner_id, o.id,
         coalesce(o.plan_id, (select p.id from public.meal_plans p where p.owner_id = o.owner_id and p.started_from = o.id limit 1))
    from public.shops s
    join public.orders o on o.owner_id = s.owner_id
    left join public.customers c on c.owner_id = o.owner_id and c.id = o.customer_id
   where s.slug = lower(trim(p_slug))
     and upper(trim(p_ref)) ~ '^[A-Z0-9]{6}$'
     and upper(right(o.id, 6)) = upper(trim(p_ref))
     and length(fuel_private.phone_digits(p_phone)) = 10
     and fuel_private.phone_digits(p_phone) in (o.contact ->> 'phoneDigits', fuel_private.phone_digits(c.phone))
   order by o.created_at desc
   limit 1;
$$;

-- The next Monday a plan will create an order for (null if not active).
create or replace function fuel_private.plan_next_week(p_status text, p_last_week date, p_skip date[])
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp := now() at time zone 'America/Chicago';
  v_today date := v_local::date;
  v_w     date;
begin
  if p_status <> 'active' then return null; end if;
  -- Orders are created Monday 6 AM: before that, this Monday is still ahead.
  v_w := v_today - (extract(isodow from v_today)::int - 1);
  if not (extract(isodow from v_local) = 1 and extract(hour from v_local) < 6) then
    v_w := v_w + 7;
  end if;
  if p_last_week is not null and v_w <= p_last_week then
    v_w := p_last_week + 7;
  end if;
  while v_w = any (coalesce(p_skip, '{}')) loop
    v_w := v_w + 7;
  end loop;
  return v_w;
end;
$$;

create or replace function fuel_private.plan_json(p_owner uuid, p_plan text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'status', p.status,
           'fulfillment', p.fulfillment,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(m.name, 'Meal no longer offered'), 'qty', (i ->> 'qty')::int, 'available', coalesce(m.active, false))), '[]'::jsonb)
                       from jsonb_array_elements(p.items) i left join public.meals m on m.owner_id = p.owner_id and m.id = i ->> 'mealId'),
           'skipWeeks', (select coalesce(jsonb_agg(w order by w), '[]'::jsonb) from unnest(p.skip_weeks) w where w >= (now() at time zone 'America/Chicago')::date - 6),
           'lastWeek', p.last_week,
           'nextWeek', fuel_private.plan_next_week(p.status, p.last_week, p.skip_weeks))
    from public.meal_plans p
   where p.owner_id = p_owner and p.id = p_plan;
$$;

create or replace function public.track_order(p_slug text, p_phone text, p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f   record;
  o   record;
  v_s jsonb;
begin
  select * into f from fuel_private.find_order(p_slug, p_phone, p_ref);
  if not found then
    raise exception 'We couldn''t find that order. Check the order code and the phone number you used.';
  end if;
  select * into o from public.orders where owner_id = f.owner_id and id = f.order_id;
  select data into v_s from public.settings where owner_id = f.owner_id;
  v_s := coalesce(v_s, '{}'::jsonb);
  return jsonb_build_object(
    'ref',          upper(right(o.id, 6)),
    'status',       o.status,
    'paid',         o.paid,
    'source',       o.source,
    'fulfillment',  o.fulfillment,
    'weekOf',       o.week_of,
    'deliveryDay',  o.week_of + 6,
    'placedOn',     o.created_on,
    'total',        o.quoted_total,
    'paymentMethod', o.payment_method,
    'cashApp',      coalesce(v_s ->> 'cashApp', ''),
    'zelle',        coalesce(v_s ->> 'zelle', ''),
    'businessName', coalesce(nullif(v_s ->> 'businessName', ''), 'Fuel by Buzah'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(m.name, 'Meal'), 'qty', (i ->> 'qty')::int)), '[]'::jsonb)
                from jsonb_array_elements(o.items) i left join public.meals m on m.owner_id = o.owner_id and m.id = i ->> 'mealId'),
    'mealCount', (select coalesce(sum((i ->> 'qty')::int), 0) from jsonb_array_elements(o.items) i),
    'plan', case when f.plan_id is null then null else fuel_private.plan_json(f.owner_id, f.plan_id) end
  );
end;
$$;

-- ---------- plan_action: pause / resume / skip / unskip / cancel ----------

create or replace function public.plan_action(p_slug text, p_phone text, p_ref text, p_action text, p_week date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f      record;
  p      record;
  v_s    jsonb;
  v_next date;
  v_first text;
  v_msg  text;
begin
  select * into f from fuel_private.find_order(p_slug, p_phone, p_ref);
  if not found or f.plan_id is null then
    raise exception 'We couldn''t find a weekly plan for that order.';
  end if;
  select * into p from public.meal_plans where owner_id = f.owner_id and id = f.plan_id for update;
  if p.status = 'cancelled' then
    raise exception 'This weekly plan was cancelled. Place a new order and tick "Repeat every week" to start again.';
  end if;
  v_next := (fuel_private.plan_json(f.owner_id, f.plan_id) ->> 'nextWeek')::date;

  if p_action = 'pause' then
    update public.meal_plans set status = 'paused', updated_at = now() where owner_id = p.owner_id and id = p.id;
    v_msg := 'paused their weekly plan';
  elsif p_action = 'resume' then
    update public.meal_plans set status = 'active', updated_at = now() where owner_id = p.owner_id and id = p.id;
    v_msg := 'resumed their weekly plan';
  elsif p_action = 'skip' then
    if p.status <> 'active' or v_next is null then
      raise exception 'Resume the plan first.';
    end if;
    update public.meal_plans set skip_weeks = (select array_agg(distinct w) from unnest(skip_weeks || v_next) w where w >= current_date - 7), updated_at = now()
     where owner_id = p.owner_id and id = p.id;
    v_msg := 'is skipping the week of ' || to_char(v_next, 'Mon FMDD');
  elsif p_action = 'unskip' then
    if p_week is null then
      raise exception 'Choose the week to put back.';
    end if;
    update public.meal_plans set skip_weeks = array_remove(skip_weeks, p_week), updated_at = now() where owner_id = p.owner_id and id = p.id;
    v_msg := 'un-skipped the week of ' || to_char(p_week, 'Mon FMDD');
  elsif p_action = 'cancel' then
    update public.meal_plans set status = 'cancelled', updated_at = now() where owner_id = p.owner_id and id = p.id;
    v_msg := 'cancelled their weekly plan';
  else
    raise exception 'Unknown action.';
  end if;

  -- Let the owner know (best effort, see v3).
  begin
    select data into v_s from public.settings where owner_id = p.owner_id;
    if coalesce((v_s ->> 'alertsEnabled')::boolean, false) then
      v_first := coalesce(nullif(split_part(trim(coalesce(p.contact ->> 'name', '')), ' ', 1), ''), 'A customer');
      perform fuel_private.send_order_alert(v_s, 'Weekly plan update', v_first || ' ' || v_msg || '.', 3);
    end if;
  exception when others then null;
  end;

  return fuel_private.plan_json(f.owner_id, f.plan_id);
end;
$$;

-- ---------- Monday: create this week's plan orders (pending) ----------

create or replace function fuel_private.generate_plan_orders(p_force boolean default false)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local   timestamp := now() at time zone 'America/Chicago';
  v_today   date := v_local::date;
  v_week    date := v_today - (extract(isodow from v_today)::int - 1);
  p         record;
  v_s       jsonb;
  v_items   jsonb;
  v_item    jsonb;
  v_left    int;
  v_price   jsonb;
  v_id      text;
  v_made    int := 0;
  v_owner   uuid := null;
  v_n       int := 0;
  v_skipped int := 0;
begin
  -- The cron fires at 11:00 and 12:00 UTC on Mondays; only the one that's 6 AM in Houston runs.
  if not p_force and (extract(isodow from v_local) <> 1 or extract(hour from v_local) <> 6) then
    return 0;
  end if;

  for p in
    select mp.* from public.meal_plans mp
     where mp.status = 'active'
       and (mp.last_week is null or mp.last_week < v_week)
       and not (v_week = any (mp.skip_weeks))
       and not exists (select 1 from public.orders o where o.owner_id = mp.owner_id and o.plan_id = mp.id and o.week_of = v_week)
     order by mp.owner_id, mp.created_at
  loop
    if v_owner is distinct from p.owner_id then
      if v_owner is not null then
        perform fuel_private.plan_summary_push(v_owner, v_n, v_skipped);
      end if;
      v_owner := p.owner_id; v_n := 0; v_skipped := 0;
    end if;
    select coalesce(data, '{}'::jsonb) into v_s from public.settings where owner_id = p.owner_id;

    -- Keep meals that are still on the menu, trimmed to what's left this week.
    v_items := '[]'::jsonb;
    for v_item in select * from jsonb_array_elements(p.items) loop
      select case when m.weekly_limit is null then 999
                  else greatest(m.weekly_limit - coalesce((select s.sold from fuel_private.meals_sold(p.owner_id, v_week) s where s.meal_id = m.id), 0), 0) end
        into v_left
        from public.meals m where m.owner_id = p.owner_id and m.id = v_item ->> 'mealId' and m.active;
      if found and v_left > 0 then
        v_items := v_items || jsonb_build_object('mealId', v_item ->> 'mealId', 'qty', least((v_item ->> 'qty')::int, v_left));
      end if;
    end loop;

    update public.meal_plans set last_week = v_week, updated_at = now() where owner_id = p.owner_id and id = p.id;
    if jsonb_array_length(v_items) = 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    begin
      v_price := fuel_private.price_order(p.owner_id, v_s, v_items, p.fulfillment, 0, v_week);
    exception when others then
      v_skipped := v_skipped + 1;
      continue;
    end;
    v_id := 'plan_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    insert into public.orders (owner_id, id, customer_id, created_on, week_of, items, fulfillment, notes,
                               late_fee, status, source, payment_method, paid, quoted_total, contact, plan_id)
    values (p.owner_id, v_id, p.customer_id, v_today, v_week, v_price -> 'items', p.fulfillment, p.notes,
            0, 'pending', 'plan', p.payment_method, false, (v_price ->> 'total')::numeric, p.contact, p.id);
    v_made := v_made + 1;
    v_n := v_n + 1;
  end loop;
  if v_owner is not null then
    perform fuel_private.plan_summary_push(v_owner, v_n, v_skipped);
  end if;
  return v_made;
end;
$$;

create or replace function fuel_private.plan_summary_push(p_owner uuid, p_made int, p_skipped int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s jsonb;
begin
  if p_made + p_skipped = 0 then return; end if;
  select data into v_s from public.settings where owner_id = p_owner;
  if coalesce((v_s ->> 'alertsEnabled')::boolean, false) then
    perform fuel_private.send_order_alert(v_s,
      'Weekly plans: ' || p_made || ' order' || case when p_made = 1 then '' else 's' end || ' to review',
      'This week''s plan orders are waiting in your inbox.'
        || case when p_skipped > 0 then ' ' || p_skipped || ' plan' || case when p_skipped = 1 then '' else 's' end || ' had no meals available.' else '' end, 3);
  end if;
exception when others then null;
end;
$$;

revoke all on function public.track_order(text, text, text) from public;
revoke all on function public.plan_action(text, text, text, text, date) from public;
grant execute on function public.track_order(text, text, text) to anon, authenticated;
grant execute on function public.plan_action(text, text, text, text, date) to anon, authenticated;

-- Belt and braces: private helpers are only callable by the functions above.
revoke execute on all functions in schema fuel_private from public, anon, authenticated;
