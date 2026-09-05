alter table swarm_hosted_chat_messages add column source text not null default 'legacy';
alter table swarm_hosted_chat_messages add column trust text not null default 'external';
alter table swarm_hosted_chat_messages add column source_label text;

alter table swarm_hosted_chat_jobs add column summary text not null default '';
alter table swarm_hosted_chat_jobs add column delivery_state text not null default 'pending';

update swarm_hosted_chat_messages
set source = case
  when role = 'assistant' then 'assistant'
  when request_id like 'x_%' then 'external-x'
  when request_id like 'telegram_%' then 'group-telegram'
  else 'owner-web'
end,
trust = case
  when role = 'assistant' then 'system'
  when request_id like 'x_%' or request_id like 'telegram_%' then 'external'
  else 'owner'
end;

update swarm_hosted_chat_jobs
set summary = coalesce((
  select substr(content, 1, 160) from swarm_hosted_chat_messages
  where swarm_hosted_chat_messages.account_id = swarm_hosted_chat_jobs.account_id
    and swarm_hosted_chat_messages.avatar_id = swarm_hosted_chat_jobs.avatar_id
    and swarm_hosted_chat_messages.request_id = swarm_hosted_chat_jobs.request_id
    and role = 'user'
  limit 1
), ''),
delivery_state = case
  when status = 'completed' then 'completed'
  when status = 'dead' then 'failed'
  when status = 'processing' then 'processing'
  else 'pending'
end;

create table if not exists swarm_hosted_memories (
  account_id text not null,
  avatar_id text not null,
  memory_id text not null,
  content text not null,
  source text not null,
  source_label text,
  shareable integer not null default 0 check (shareable in (0, 1)),
  created_at integer not null,
  updated_at integer not null,
  primary key (account_id, avatar_id, memory_id),
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists idx_swarm_hosted_memories_recent
  on swarm_hosted_memories (account_id, avatar_id, created_at desc);

create table if not exists swarm_hosted_scheduled_jobs (
  id text primary key,
  account_id text not null,
  avatar_id text not null,
  type text not null,
  payload_json text not null,
  summary text not null,
  run_at integer not null,
  created_at integer not null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'completed', 'failed')),
  claimed_at integer,
  completed_at integer,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists idx_swarm_hosted_scheduled_jobs_due
  on swarm_hosted_scheduled_jobs (status, run_at);

update swarm_hosted_avatars set status = 'ready' where status = 'shell';
