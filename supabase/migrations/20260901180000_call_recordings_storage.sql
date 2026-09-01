-- Call recordings storage bucket (run in Supabase SQL editor if uploads fail)
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', true)
on conflict (id) do nothing;
