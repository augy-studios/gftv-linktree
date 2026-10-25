-- 008_site_insights.sql
--
-- Run once in the Supabase SQL editor, after 007. The site-wide numbers on
-- the home page's insights tiles, worked out in the database so the API reads
-- one small answer however many pages and days there are.
--
-- While OneLink is new it borrows from the GFTV short links' own visit log,
-- gftvlinks_linkvisits (owned by that app, read here, never written): every
-- row there is a click on a GFTV link, so it adds to the clicks, the daily
-- clicks and the device split. That table has no country or referring site,
-- so those come from OneLink alone. It is read only when it exists, so this
-- keeps working, on OneLink's numbers alone, if it is ever dropped.
--
-- Totals only: nothing about any one visitor or page leaves this function.
--
-- This file is never edited after it has been run. Changes go in 009 onwards.

begin;

create or replace function gftvonelink_site_insights()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Singapore')::date;
  v_from timestamptz := ((now() at time zone 'Asia/Singapore')::date - 29)::timestamp at time zone 'Asia/Singapore';
  v_link_clicks bigint := 0;
  v_link_daily jsonb := '{}'::jsonb;
  v_link_devices jsonb := '{}'::jsonb;
  v_result jsonb;
begin
  if to_regclass('public.gftvlinks_linkvisits') is not null then
    execute 'select count(*) from gftvlinks_linkvisits' into v_link_clicks;
    execute $q$
      select coalesce(jsonb_object_agg(d, n), '{}'::jsonb)
        from (select (visited_at at time zone 'Asia/Singapore')::date as d, count(*) as n
                from gftvlinks_linkvisits
               where visited_at >= $1
               group by 1) t
    $q$ into v_link_daily using v_from;
    execute $q$
      select coalesce(jsonb_object_agg(lower(device_type), n), '{}'::jsonb)
        from (select device_type, count(*) as n from gftvlinks_linkvisits group by 1) t
    $q$ into v_link_devices;
  end if;

  select jsonb_build_object(
    'visits', coalesce((select sum(hits) from gftvonelink_page_stats where kind = 'visits'), 0),
    'clicks', coalesce((select sum(hits) from gftvonelink_page_stats where kind = 'clicks'), 0) + v_link_clicks,
    'pages', (select count(*) from gftvonelink_pages where status = 'active'),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', g.d, 'clicks', coalesce(s.hits, 0) + coalesce((v_link_daily ->> g.d::text)::bigint, 0)) order by g.d)
        from (select v_today - i as d from generate_series(0, 29) as i) g
        left join (select day, sum(hits) as hits
                     from gftvonelink_page_stats
                    where kind = 'clicks' and day >= v_today - 29
                    group by day) s on s.day = g.d
    ),
    'devices', (
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
        from (select k, sum(n) as n
                from (select key as k, sum(hits) as n from gftvonelink_page_stats where kind = 'device' group by key
                      union all
                      select key as k, value::bigint as n from jsonb_each_text(v_link_devices)) u
               group by k) t
    ),
    'country', (
      select jsonb_build_object('key', key, 'hits', sum(hits))
        from gftvonelink_page_stats
       where kind = 'country' and key <> 'XX'
       group by key
       order by sum(hits) desc
       limit 1
    ),
    'referrer', (
      select jsonb_build_object('key', key, 'hits', sum(hits))
        from gftvonelink_page_stats
       where kind = 'referrer' and key <> ''
       group by key
       order by sum(hits) desc
       limit 1
    )
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function gftvonelink_site_insights() from public, anon, authenticated;
grant execute on function gftvonelink_site_insights() to service_role;

commit;

-- Rollback:
--
-- drop function if exists gftvonelink_site_insights();
