-- Fuel by Buzah — v3: push alerts to the owner's phone for new online orders
-- Run AFTER v2_online_ordering.sql. Safe to re-run.
--
-- How it works: when place_order() inserts a pending online order, a trigger
-- queues an HTTPS request (pg_net) to ntfy.sh, which pushes a notification to
-- the ntfy app on the owner's phone. The request is sent in the background
-- after the order commits, so a slow or failed alert never blocks an order.
--
-- Privacy: the alert only contains the customer's first name, meal count,
-- total and delivery day. The ntfy topic is a long random string generated in
-- the manager (it works like a password) and is never exposed by get_shop().

create extension if not exists pg_net with schema extensions;

create or replace function fuel_private.send_order_alert(p_settings jsonb, p_title text, p_message text, p_priority int)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text := p_settings ->> 'ntfyTopic';
  v_click text := p_settings ->> 'managerUrl';
begin
  if v_topic is null or v_topic !~ '^[A-Za-z0-9_-]{16,64}$' then
    return null;
  end if;
  if v_click is not null and v_click !~ '^https://[^\s"<>]+$' then
    v_click := null;
  end if;
  return net.http_post(
    url  := 'https://ntfy.sh/',
    body := jsonb_strip_nulls(jsonb_build_object(
      'topic',    v_topic,
      'title',    left(p_title, 120),
      'message',  left(p_message, 500),
      'tags',     jsonb_build_array('fork_and_knife'),
      'priority', p_priority,
      'click',    case when v_click is null then null else split_part(v_click, '#', 1) || '#orders' end
    ))
  );
end;
$$;

create or replace function fuel_private.notify_new_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     jsonb;
  v_meals int;
  v_first text;
begin
  select data into v_s from public.settings where owner_id = new.owner_id;
  if v_s is null or not coalesce((v_s ->> 'alertsEnabled')::boolean, false) then
    return new;
  end if;

  select coalesce(sum((i ->> 'qty')::int), 0) into v_meals from jsonb_array_elements(new.items) i;
  v_first := coalesce(nullif(split_part(trim(coalesce(new.contact ->> 'name', '')), ' ', 1), ''), 'A customer');

  perform fuel_private.send_order_alert(
    v_s,
    'New order: ' || v_first,
    v_meals || ' meal' || case when v_meals = 1 then '' else 's' end
      || ' · $' || to_char(coalesce(new.quoted_total, 0), 'FM999990.00')
      || ' · ' || new.fulfillment || ' ' || to_char(new.week_of + 6, 'Dy, Mon FMDD')
      || E'\nTap to review and confirm.',
    4
  );
  return new;
exception when others then
  -- An alert problem must never stop a customer's order from saving.
  return new;
end;
$$;

drop trigger if exists orders_notify_new on public.orders;
create trigger orders_notify_new
  after insert on public.orders
  for each row
  when (new.source = 'online' and new.status = 'pending')
  execute function fuel_private.notify_new_order();

-- "Send test alert" button in the manager. Owner-only: uses the caller's own settings.
create or replace function public.send_test_alert()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s  jsonb;
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select data into v_s from public.settings where owner_id = auth.uid();
  if v_s is null or coalesce(v_s ->> 'ntfyTopic', '') !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'Turn on alerts first.';
  end if;
  v_id := fuel_private.send_order_alert(v_s, 'Test alert from ' || coalesce(nullif(v_s ->> 'businessName', ''), 'Fuel by Buzah'),
                                        'Alerts are working. New online orders will show up like this.', 3);
  return jsonb_build_object('requestId', v_id);
end;
$$;

revoke all on function public.send_test_alert() from public, anon;
grant execute on function public.send_test_alert() to authenticated;
