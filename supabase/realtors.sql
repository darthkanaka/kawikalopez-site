-- kawikalopez.com realtor program, in the Veex Supabase project (tables prefixed kl_).
--
-- A Hawaiʻi realtor signs up on /realtors with their brokerage email and gets a personal 15% code,
-- created in Stripe for their own Stripe customer, so the code only works when they check out
-- signed in with that email. Plan and decisions: vault projects/realtor-gift-program.md.
--
-- Safe to run again: everything is create-if-missing or create-or-replace. The domain list is
-- loaded separately by supabase/seed_domains.py from data/free-email-domains.txt.

-- 1. Free and home-internet email domains, refused at sign-up.
create table if not exists public.kl_free_email_domains (
  domain text primary key
);
alter table public.kl_free_email_domains enable row level security;
-- No policies: nobody reads this table through the API. The check below runs as its owner.

create or replace function public.kl_is_free_domain(d text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.kl_free_email_domains f
    where lower(d) = f.domain or lower(d) like '%.' || f.domain
  );
$$;
revoke execute on function public.kl_is_free_domain(text) from public, anon, authenticated;
grant execute on function public.kl_is_free_domain(text) to service_role, supabase_auth_admin;

-- 2. One row per realtor, keyed to their Supabase login.
create table if not exists public.kl_realtors (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null,
  brokerage text not null,
  phone text,
  license_number text not null,
  license_type text not null check (license_type in ('RS', 'RB')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- Live Stripe customer and code, used on kawikalopez.com.
  stripe_customer_id text,
  stripe_promo_id text,
  promo_code text,
  -- Sandbox customer and code, used on the staging site while testing.
  test_stripe_customer_id text,
  test_stripe_promo_id text,
  test_promo_code text,
  welcome_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.kl_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists kl_realtors_touch on public.kl_realtors;
create trigger kl_realtors_touch before update on public.kl_realtors
  for each row execute function public.kl_touch_updated_at();

-- A signed-in realtor can read their own row (the checkout script reads it with their sign-in
-- to find their Stripe customer and code). Nobody can write through the API; the kl-realtor
-- Edge Function writes with the secret key.
alter table public.kl_realtors enable row level security;
drop policy if exists "realtor reads own row" on public.kl_realtors;
create policy "realtor reads own row" on public.kl_realtors
  for select to authenticated using ((select auth.uid()) = id);
revoke all on public.kl_realtors from anon;
revoke insert, update, delete on public.kl_realtors from authenticated;
grant select on public.kl_realtors to authenticated;

-- 3. Before an account is created: refuse free and home-internet email domains.
-- Wired up in the auth config as hook_before_user_created_uri =
-- pg-functions://postgres/public/kl_before_user_created.
create or replace function public.kl_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  addr text := lower(coalesce(event -> 'user' ->> 'email', ''));
  dom text := split_part(addr, '@', 2);
begin
  if dom <> '' and public.kl_is_free_domain(dom) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Please sign up with your brokerage email. Free email addresses can''t be used for realtor accounts.'
    ));
  end if;
  return '{}'::jsonb;
end;
$$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.kl_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.kl_before_user_created(jsonb) from public, anon, authenticated;
