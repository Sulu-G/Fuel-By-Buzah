-- Fuel by Buzah — v5: nightly food-recall check for your ingredients
-- Run AFTER v4. Safe to re-run.
--
-- Every night at 8pm Central the database:
--   1. downloads active FDA food recalls (openFDA enforcement API) and tries the
--      USDA FSIS recall API (meat/poultry/eggs);
--   2. matches each recall against the ingredients on your active menu;
--   3. stores matches in public.recall_alerts (owner-only, Row Level Security);
--   4. sends a push alert (ntfy) — a full summary on Friday night (the night
--      before Saturday shopping), and on other nights only if something new matched.
-- "Check now" in the app runs the same check on demand (no push).

create extension if not exists pg_net with schema extensions;

-- ---------- What the owner sees ----------

create table if not exists public.recall_alerts (
  owner_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id             text not null,              -- '<source>:<recall number>'
  ingredient     text not null,              -- which of your ingredients matched
  match          text not null default 'direct' check (match in ('direct', 'related')),
  source         text not null check (source in ('fda', 'usda')),
  recall_number  text not null,
  product        text not null default '',
  firm           text not null default '',
  reason         text not null default '',
  hazard         text not null default 'other',
  classification text not null default '',
  status         text not null default '',
  recall_date    date,
  distribution   text not null default '',
  affects_tx     text not null default 'unknown' check (affects_tx in ('yes', 'no', 'unknown')),
  code_info      text not null default '',
  url            text not null default '',
  active         boolean not null default true,
  dismissed      boolean not null default false,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  primary key (owner_id, id, ingredient)
);

create table if not exists public.recall_runs (
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id                  bigint generated always as identity,
  ran_at              timestamptz not null default now(),
  kind                text not null,          -- friday | daily | manual
  fda_ok              boolean,
  usda_ok             boolean,
  recalls_checked     int not null default 0,
  ingredients_checked int not null default 0,
  matches             int not null default 0,
  new_matches         int not null default 0,
  primary key (owner_id, id)
);

alter table public.recall_alerts enable row level security;
alter table public.recall_runs   enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recall_alerts' and policyname = 'owner_read') then
    create policy owner_read on public.recall_alerts for select to authenticated using (owner_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recall_alerts' and policyname = 'owner_dismiss') then
    create policy owner_dismiss on public.recall_alerts for update to authenticated
      using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recall_runs' and policyname = 'owner_read') then
    create policy owner_read on public.recall_runs for select to authenticated using (owner_id = (select auth.uid()));
  end if;
end $$;

revoke all on public.recall_alerts, public.recall_runs from anon, authenticated;
grant select on public.recall_alerts, public.recall_runs to authenticated;
grant update (dismissed) on public.recall_alerts to authenticated;   -- the only thing the app may change

alter table public.recall_alerts add column if not exists match text not null default 'direct' check (match in ('direct', 'related'));

create index if not exists recall_alerts_owner_active_idx on public.recall_alerts (owner_id, active, dismissed);

-- ---------- Private working tables ----------

create schema if not exists fuel_private;
revoke all on schema fuel_private from public, anon, authenticated;

create table if not exists fuel_private.recall_batches (
  id            bigint generated always as identity primary key,
  kind          text not null,
  requested_by  uuid,
  requested_at  timestamptz not null default now(),
  fda_request   bigint,
  usda_request  bigint,
  processed_at  timestamptz,
  fda_ok        boolean,
  usda_ok       boolean,
  fda_count     int,
  usda_count    int
);

create table if not exists fuel_private.recall_items (
  batch_id       bigint not null references fuel_private.recall_batches (id) on delete cascade,
  source         text not null,
  recall_number  text not null,
  product        text not null default '',
  firm           text not null default '',
  reason         text not null default '',
  classification text not null default '',
  status         text not null default '',
  recall_date    date,
  distribution   text not null default '',
  code_info      text not null default '',
  url            text not null default '',
  primary key (batch_id, source, recall_number)
);

-- ---------- Helpers ----------

-- Does this text mention the ingredient? Every meaningful word of the ingredient
-- must appear as the end of a word, allowing plurals ("berries" matches
-- "blueberries" and "strawberry"; "salmon" does NOT match "Salmonella").
-- Short or ambiguous words must be the whole word ("rice" won't match "licorice").
create or replace function fuel_private.ingredient_matches(p_text text, p_item text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  t      text := lower(coalesce(p_text, ''));
  w      text;
  stem   text;
  words  int := 0;
  stop   text[] := array['fresh', 'frozen', 'organic', 'large', 'small', 'medium', 'boneless', 'skinless', 'raw',
                         'cooked', 'light', 'lite', 'low', 'reduced', 'fat', 'free', 'whole', 'sliced', 'diced',
                         'chopped', 'lean', 'extra', 'virgin', 'and', 'with', 'the', 'for', 'each', 'cup', 'cups',
                         'scoop', 'piece', 'pieces', 'plain'];
  strict_words text[] := array['rice', 'pear', 'corn', 'lime', 'date', 'plum', 'beet', 'bean', 'oat', 'egg', 'ham', 'pea',
                               'yam', 'fig', 'nut', 'tea', 'oil', 'ice'];
begin
  foreach w in array regexp_split_to_array(lower(coalesce(p_item, '')), '[^a-z]+') loop
    if length(w) < 3 or w = any (stop) then
      continue;
    end if;
    stem := case
      when w ~ 'ies$' then left(w, -3)
      when w ~ '(oes|ches|shes|xes)$' then left(w, -2)
      when w ~ '[^s]s$' then left(w, -1)
      else w end;
    words := words + 1;
    if length(stem) < 4 or stem = any (strict_words) then
      if t !~ ('\m' || stem || '(s|es|y|ies)?\M') then return false; end if;
    elsif t !~ (stem || '(s|es|y|ies)?\M') then
      return false;
    end if;
  end loop;
  return words > 0;
end;
$$;

-- How closely does a recall match one of your ingredients?
--   'direct'  — the recalled product IS that grocery item ("Organic Whole Blueberries, 10 oz")
--   'related' — it only contains it ("Blackberry Honey Spread", "Garlic Herb Topping",
--               an ingredient list, or a recall of a supplier's ingredient)
--   null      — no match
create or replace function fuel_private.recall_match(p_product text, p_reason text, p_item text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  seg       text;
  item_words text[];
  processed text[] := array['sauce', 'sauces', 'seasoning', 'seasonings', 'chips', 'chip', 'crisps', 'cracker', 'crackers',
    'spread', 'honey', 'cream', 'creamer', 'dip', 'dips', 'bar', 'bars', 'candy', 'candies', 'chocolate', 'chocolates',
    'cookie', 'cookies', 'smoothie', 'smoothies', 'drink', 'drinks', 'beverage', 'juice', 'tea', 'coffee', 'topping',
    'toppings', 'topper', 'dressing', 'soup', 'soups', 'salad', 'salads', 'puree', 'formula', 'supplement', 'supplements',
    'syrup', 'gummies', 'gummy', 'capsules', 'tablets', 'extract', 'jam', 'jelly', 'preserves', 'pie', 'pies', 'cake',
    'cakes', 'muffin', 'muffins', 'bread', 'bagel', 'bagels', 'pastry', 'pastries', 'snack', 'snacks', 'flavor', 'flavored',
    'fries', 'burrito', 'burritos', 'taco', 'tacos', 'pizza', 'sandwich', 'sandwiches', 'wrap', 'wraps', 'meal', 'meals',
    'entree', 'kit', 'kits', 'dumpling', 'dumplings', 'noodle', 'noodles', 'cereal', 'granola', 'trail', 'butter', 'oil',
    'vinegar', 'ketchup', 'mustard', 'mayonnaise', 'pudding', 'yogurt', 'cheese', 'milk', 'boba', 'baby', 'enhancer',
    'replacement', 'protein', 'powdered', 'blend', 'sushi', 'roll', 'rolls', 'quiche', 'casserole', 'pasta', 'tortilla',
    'tortillas', 'cobbler', 'tart', 'tarts', 'wafer', 'wafers', 'pretzel', 'pretzels', 'popcorn', 'lemonade', 'soda',
    'kombucha', 'sorbet', 'gelato', 'pops', 'popsicle', 'dessert', 'treat', 'treats', 'jerky', 'sausage', 'hummus', 'pesto',
    'sherbet', 'sherbert', 'mix', 'mixes', 'sprout', 'sprouts'];
begin
  if not fuel_private.ingredient_matches(p_product, p_item)
     and not (coalesce(p_reason, '') ~* 'ingredient' and fuel_private.ingredient_matches(p_reason, p_item)) then
    return null;
  end if;
  -- The product's name: the text before sizes, ingredient lists, codes and commas.
  seg := split_part(regexp_replace(lower(coalesce(p_product, '')),
           '(,|;|\(|\s-\s|\.\s|\mnet\s*w|\mingredients?\M|\mupc\M|\mcontains\M|\d+(\.\d+)?\s*(oz|ounce|ounces|lb|lbs|pound|pounds|g|kg|ml|l|fl|ct|count)\M).*$', ''),
           E'\n', 1);
  if not fuel_private.ingredient_matches(seg, p_item) then
    return 'related';
  end if;
  item_words := regexp_split_to_array(lower(coalesce(p_item, '')), '[^a-z]+');
  if exists (select 1 from regexp_split_to_table(seg, '[^a-z]+') x
              where x = any (processed) and not (x = any (item_words))) then
    return 'related';
  end if;
  return 'direct';
end;
$$;

-- Short hazard key from the recall's stated reason.
create or replace function fuel_private.recall_hazard(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when r ~* 'listeria' then 'listeria'
    when r ~* 'salmonella' then 'salmonella'
    when r ~* '(e\.? ?coli|\mstec\M|shiga|o157)' then 'ecoli'
    when r ~* 'botul' then 'botulism'
    when r ~* 'hepatitis' then 'hepatitis_a'
    when r ~* 'cyclospora' then 'cyclospora'
    when r ~* 'norovirus' then 'norovirus'
    when r ~* '(undeclared|allergen|\mmilk\M|peanut|tree nut|\msoy|\mwheat|\megg|sesame|shellfish|crustacean)' then 'allergen'
    when r ~* '(\mlead\M|cadmium|arsenic|mercury|heavy metal)' then 'heavy_metals'
    when r ~* '(foreign|\mmetal|plastic|glass|rubber|\mwood|bone fragment|\mstone)' then 'foreign'
    when r ~* '(inspection|insanitary|unsanitary|temperature|processing|under.?process|cgmp|haccp|sanitation)' then 'process'
    else 'other'
  end
  from (select coalesce(p_reason, '') as r) x;
$$;

create or replace function fuel_private.hazard_short(p_hazard text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_hazard
    when 'listeria' then 'Listeria — serious for pregnant people, newborns, 65+ and weakened immunity'
    when 'salmonella' then 'Salmonella — food poisoning'
    when 'ecoli' then 'E. coli — can cause kidney failure (HUS)'
    when 'botulism' then 'Botulism — life-threatening'
    when 'allergen' then 'Undeclared allergen'
    when 'foreign' then 'Foreign material (choking/injury)'
    when 'hepatitis_a' then 'Hepatitis A'
    when 'cyclospora' then 'Cyclospora parasite'
    when 'norovirus' then 'Norovirus'
    when 'heavy_metals' then 'Lead / heavy metals'
    when 'process' then 'Safety-control problem'
    else 'See recall notice'
  end;
$$;

-- Was it distributed to Texas? yes / no / unknown.
create or replace function fuel_private.recall_affects_tx(p_distribution text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d ~* '(nationwide|nation-wide|all states|\mtexas\M|throughout the (u\.?s|united states)|u\.?s\.?.?wide|all 50)' or d ~ '\mTX\M' then 'yes'
    when d ~ '\m(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|UT|VT|VA|WA|WV|WI|WY)\M' then 'no'
    else 'unknown'
  end
  from (select coalesce(p_distribution, '') as d) x;
$$;

-- Generic push to the owner's ntfy topic (see v3). p_path is the manager tab to open.
create or replace function fuel_private.send_push(p_settings jsonb, p_title text, p_message text, p_priority int, p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text := p_settings ->> 'ntfyTopic';
  v_click text := p_settings ->> 'managerUrl';
begin
  if not coalesce((p_settings ->> 'alertsEnabled')::boolean, false) or v_topic is null or v_topic !~ '^[A-Za-z0-9_-]{16,64}$' then
    return null;
  end if;
  if v_click is not null and v_click !~ '^https://[^\s"<>]+$' then
    v_click := null;
  end if;
  return net.http_post(
    url  := 'https://ntfy.sh/',
    body := jsonb_strip_nulls(jsonb_build_object(
      'topic', v_topic, 'title', left(p_title, 120), 'message', left(p_message, 1000),
      'tags', jsonb_build_array('warning'), 'priority', p_priority,
      'click', case when v_click is null then null else split_part(v_click, '#', 1) || '#' || p_path end)));
end;
$$;

-- ---------- 1. Request the feeds (responses arrive in the background) ----------

create or replace function fuel_private.request_recall_feeds(p_kind text, p_requested_by uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_fda   bigint;
  v_usda  bigint;
  v_id    bigint;
begin
  v_fda := net.http_get(
    url := 'https://api.fda.gov/food/enforcement.json',
    params := jsonb_build_object(
      'search', 'report_date:[' || to_char(v_today - 180, 'YYYYMMDD') || ' TO ' || to_char(v_today + 1, 'YYYYMMDD') || '] AND status:"Ongoing"',
      'limit', '1000'),
    headers := '{"User-Agent":"FuelByBuzah-recall-check/1.0"}'::jsonb,
    timeout_milliseconds := 30000);
  v_usda := net.http_get(
    url := 'https://www.fsis.usda.gov/fsis/api/recall/v/1',
    headers := '{"User-Agent":"FuelByBuzah-recall-check/1.0","Accept":"application/json"}'::jsonb,
    timeout_milliseconds := 30000);
  insert into fuel_private.recall_batches (kind, requested_by, fda_request, usda_request)
  values (p_kind, p_requested_by, v_fda, v_usda)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------- 2. Parse, match, store, notify ----------

create or replace function fuel_private.process_recall_batches()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  b         record;
  o         record;
  fda_code  int;
  fda_body  text;
  usda_code int;
  usda_body text;
  v_fda_ok  boolean;
  v_usda_ok boolean;
  v_done    int := 0;
  v_ings    int;
  v_matches int;
  v_new     int;
  v_today   date := (now() at time zone 'America/Chicago')::date;
  v_ws      date;
  v_onlist  text;
  v_onlist_n int;
  v_newlist text;
  v_note    text;
  v_related int;
begin
  for b in select * from fuel_private.recall_batches where processed_at is null order by id for update skip locked loop
    select r.status_code, r.content into fda_code, fda_body from net._http_response r where r.id = b.fda_request;
    select r.status_code, r.content into usda_code, usda_body from net._http_response r where r.id = b.usda_request;
    -- Wait for both responses (up to 2 minutes), then process with whatever arrived.
    if (fda_code is null or usda_code is null) and now() - b.requested_at < interval '2 minutes' then
      continue;
    end if;

    -- FDA
    v_fda_ok := coalesce(fda_code = 200, false);
    if v_fda_ok then
      begin
        insert into fuel_private.recall_items (batch_id, source, recall_number, product, firm, reason, classification,
                                               status, recall_date, distribution, code_info, url)
        select b.id, 'fda', x ->> 'recall_number', coalesce(x ->> 'product_description', ''), coalesce(x ->> 'recalling_firm', ''),
               coalesce(x ->> 'reason_for_recall', ''), coalesce(x ->> 'classification', ''), coalesce(x ->> 'status', ''),
               to_date(nullif(x ->> 'recall_initiation_date', ''), 'YYYYMMDD'), coalesce(x ->> 'distribution_pattern', ''),
               left(coalesce(x ->> 'code_info', ''), 1000), ''
        from jsonb_array_elements(fda_body::jsonb -> 'results') x
        where coalesce(x ->> 'recall_number', '') <> ''
        on conflict do nothing;
      exception when others then
        v_fda_ok := false;
      end;
    end if;

    -- USDA FSIS (best effort; its site often refuses cloud servers)
    v_usda_ok := coalesce(usda_code = 200, false);
    if v_usda_ok then
      begin
        insert into fuel_private.recall_items (batch_id, source, recall_number, product, firm, reason, classification,
                                               status, recall_date, distribution, code_info, url)
        select b.id, 'usda', coalesce(nullif(x ->> 'field_recall_number', ''), md5(x::text)),
               regexp_replace(coalesce(x ->> 'field_title', '') || ' ' || coalesce(x ->> 'field_product_items', ''), '<[^>]+>', ' ', 'g'),
               coalesce(x ->> 'field_establishment', ''),
               regexp_replace(coalesce(nullif(x ->> 'field_recall_reason', ''), '') || ' ' || coalesce(x ->> 'field_summary', ''), '<[^>]+>', ' ', 'g'),
               coalesce(x ->> 'field_risk_level', ''), 'Ongoing',
               case when coalesce(x ->> 'field_recall_date', '') ~ '^\d{4}-\d{2}-\d{2}' then left(x ->> 'field_recall_date', 10)::date end,
               coalesce(x ->> 'field_states', ''), '', coalesce(x ->> 'field_recall_url', '')
        from jsonb_array_elements(usda_body::jsonb) x
        where lower(coalesce(x ->> 'field_active_notice', 'true')) in ('true', '1', 'yes')
          and coalesce(x ->> 'langcode', 'English') ilike 'en%'
        on conflict do nothing;
      exception when others then
        v_usda_ok := false;
      end;
    end if;

    update fuel_private.recall_batches
       set processed_at = now(), fda_ok = v_fda_ok, usda_ok = v_usda_ok,
           fda_count = (select count(*) from fuel_private.recall_items i where i.batch_id = b.id and i.source = 'fda'),
           usda_count = (select count(*) from fuel_private.recall_items i where i.batch_id = b.id and i.source = 'usda')
     where id = b.id;

    -- Match for each owner (manual checks: only the owner who asked)
    for o in
      select s.owner_id, s.data from public.settings s
       where coalesce((s.data ->> 'recallChecks')::boolean, true)
         and (b.requested_by is null or s.owner_id = b.requested_by)
    loop
      select count(distinct lower(trim(i ->> 'item'))) into v_ings
        from public.meals m, jsonb_array_elements(m.ingredients) i
       where m.owner_id = o.owner_id and m.active and coalesce(trim(i ->> 'item'), '') <> '';
      if v_ings = 0 then
        continue;
      end if;

      with ing as (
        select distinct lower(trim(i ->> 'item')) as item
          from public.meals m, jsonb_array_elements(m.ingredients) i
         where m.owner_id = o.owner_id and m.active and coalesce(trim(i ->> 'item'), '') <> ''
      ), hits as (
        select * from (
          select ing.item, fuel_private.recall_match(ri.product, ri.reason, ing.item) as strength, ri.*
            from ing join fuel_private.recall_items ri on ri.batch_id = b.id
        ) x where x.strength is not null
      ), up as (
        insert into public.recall_alerts as a (owner_id, id, ingredient, match, source, recall_number, product, firm, reason, hazard,
                                         classification, status, recall_date, distribution, affects_tx, code_info, url,
                                         active, first_seen, last_seen)
        select o.owner_id, h.source || ':' || h.recall_number, h.item, h.strength, h.source, h.recall_number, left(h.product, 2000), h.firm,
               left(h.reason, 2000), fuel_private.recall_hazard(h.reason), h.classification, h.status, h.recall_date,
               left(h.distribution, 1000), fuel_private.recall_affects_tx(h.distribution), h.code_info, h.url, true, now(), now()
          from hits h
        on conflict (owner_id, id, ingredient) do update
          set last_seen = now(), active = true, match = excluded.match, status = excluded.status, classification = excluded.classification,
              distribution = excluded.distribution, affects_tx = excluded.affects_tx
        returning (xmax = 0) as inserted, match
      )
      select count(*), count(*) filter (where inserted and match = 'direct') into v_matches, v_new from up;

      -- Recalls that dropped out of an official source's feed are no longer active.
      if v_fda_ok then
        update public.recall_alerts set active = false
         where owner_id = o.owner_id and source = 'fda' and active and last_seen < b.requested_at;
      end if;
      if v_usda_ok then
        update public.recall_alerts set active = false
         where owner_id = o.owner_id and source = 'usda' and active and last_seen < b.requested_at;
      end if;

      insert into public.recall_runs (owner_id, kind, fda_ok, usda_ok, recalls_checked, ingredients_checked, matches, new_matches)
      values (o.owner_id, b.kind, v_fda_ok, v_usda_ok,
              (select count(*) from fuel_private.recall_items i where i.batch_id = b.id), v_ings, v_matches, v_new);

      if b.kind in ('friday', 'daily') then
        -- Ingredients on the coming shopping trip (this week's confirmed orders; Sunday looks ahead).
        v_ws := v_today - (extract(isodow from v_today)::int - 1) + case when extract(isodow from v_today) = 7 then 7 else 0 end;
        select string_agg(distinct a.ingredient || ' (' || fuel_private.hazard_short(a.hazard) || ', ' || coalesce(nullif(a.classification, ''), 'unclassified') || ')', '; '),
               count(distinct a.id || a.ingredient)
          into v_onlist, v_onlist_n
          from public.recall_alerts a
         where a.owner_id = o.owner_id and a.active and not a.dismissed and a.match = 'direct'
           and a.ingredient in (
             select distinct lower(trim(i ->> 'item'))
               from public.orders ord
               cross join lateral jsonb_array_elements(ord.items) it
               join public.meals m on m.owner_id = ord.owner_id and m.id = it ->> 'mealId'
               cross join lateral jsonb_array_elements(m.ingredients) i
              where ord.owner_id = o.owner_id and ord.status = 'confirmed' and ord.week_of = v_ws);
        select count(*) into v_related
          from public.recall_alerts a
         where a.owner_id = o.owner_id and a.active and not a.dismissed and a.match = 'related';
        v_note := case when v_related > 0 then ' ' || v_related || ' possibly related recall' || case when v_related = 1 then '' else 's' end || ' (products that contain your ingredients) in the app.' else '' end
               || case when not v_fda_ok then ' FDA data could not be reached tonight.' else '' end
               || case when not v_usda_ok then ' USDA meat/poultry recalls weren''t checked — see fsis.usda.gov/recalls.' else '' end;

        if b.kind = 'friday' then
          if coalesce(v_onlist_n, 0) > 0 then
            perform fuel_private.send_push(o.data, 'Recall check: ' || v_onlist_n || ' match' || case when v_onlist_n = 1 then '' else 'es' end || ' on tomorrow''s list',
              'Check brand & lot codes before buying: ' || v_onlist || '.' || v_note, 4, 'prep');
          else
            perform fuel_private.send_push(o.data, 'Recall check: all clear for tomorrow',
              'No active FDA recall is for an item on tomorrow''s shopping list (' || v_ings || ' menu ingredients checked).' || v_note, 2, 'prep');
          end if;
        elsif v_new > 0 then
          select string_agg(distinct a.ingredient || ' (' || fuel_private.hazard_short(a.hazard) || ')', '; ') into v_newlist
            from public.recall_alerts a
           where a.owner_id = o.owner_id and a.first_seen >= b.requested_at and not a.dismissed and a.match = 'direct';
          perform fuel_private.send_push(o.data, 'New recall may affect your menu',
            v_newlist || '. Open Saturday Prep for details.', 4, 'prep');
        end if;
      end if;
    end loop;

    v_done := v_done + 1;
  end loop;

  -- Housekeeping: keep two weeks of raw batches.
  delete from fuel_private.recall_batches where requested_at < now() - interval '14 days';
  return v_done;
end;
$$;

-- ---------- 3. Schedule entry point: 8pm Central, every night ----------

create or replace function fuel_private.recall_cron_request()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := now() at time zone 'America/Chicago';
begin
  -- The cron fires at 01:00 and 02:00 UTC; only the one that is 8pm in Houston runs
  -- (handles daylight saving time automatically).
  if extract(hour from v_local) <> 20 then
    return null;
  end if;
  return fuel_private.request_recall_feeds(case when extract(isodow from v_local) = 5 then 'friday' else 'daily' end, null);
end;
$$;

-- ---------- 4. "Check now" from the app ----------

create or replace function public.run_recall_check()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  bigint;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  -- One manual check per owner every 2 minutes.
  select id into v_id from fuel_private.recall_batches
   where requested_by = v_uid and requested_at > now() - interval '2 minutes'
   order by id desc limit 1;
  if v_id is null then
    v_id := fuel_private.request_recall_feeds('manual', v_uid);
  end if;
  return jsonb_build_object('batchId', v_id);
end;
$$;

create or replace function public.recall_check_status(p_batch bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  b     record;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  select * into b from fuel_private.recall_batches where id = p_batch and requested_by = v_uid;
  if not found then
    raise exception 'Unknown check.';
  end if;
  if b.processed_at is null then
    perform fuel_private.process_recall_batches();
    select * into b from fuel_private.recall_batches where id = p_batch;
  end if;
  return jsonb_build_object('done', b.processed_at is not null, 'fdaOk', b.fda_ok, 'usdaOk', b.usda_ok,
                            'fdaCount', b.fda_count, 'usdaCount', b.usda_count);
end;
$$;

revoke all on function public.run_recall_check() from public, anon;
revoke all on function public.recall_check_status(bigint) from public, anon;
grant execute on function public.run_recall_check() to authenticated;
grant execute on function public.recall_check_status(bigint) to authenticated;
