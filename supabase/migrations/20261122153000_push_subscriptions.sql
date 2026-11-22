-- Penny Alerts — push_subscriptions table.
--
-- JOSEPH STEP: run this whole file in the Supabase dashboard for the
-- "bulk finder" project → SQL editor → New query → paste → Run.
-- It is NOT applied by the GitHub push. It creates the table the app
-- writes push subscriptions to (one row per phone that enables alerts).
-- Reads and deletes happen only via the service_role key (the sender
-- script), which bypasses RLS. See README.md.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

-- New tables get NO automatic Data API grants (Supabase, Oct 30 2026):
-- grants and RLS are separate layers; both are required, or PostgREST
-- returns "permission denied" even with correct policies.
grant usage on schema public to anon, authenticated;
grant insert on table public.push_subscriptions to anon, authenticated;

-- The app (anon/publishable key) may INSERT its own subscription only.
-- It may NOT read, update, or delete rows: there is deliberately no
-- SELECT/UPDATE/DELETE policy for anon. The sender uses service_role.
create policy "anon insert push subscription"
  on public.push_subscriptions for insert to anon
  with check (true);
create policy "authenticated insert push subscription"
  on public.push_subscriptions for insert to authenticated
  with check (true);
