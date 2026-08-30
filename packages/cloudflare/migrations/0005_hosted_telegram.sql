create table if not exists swarm_hosted_telegram_integrations (
  account_id text not null,
  avatar_id text not null,
  integration_id text not null,
  bot_user_id text not null,
  bot_username text not null,
  bot_name text not null,
  status text not null check (status in ('binding_required', 'connected', 'repair_needed')),
  owner_telegram_user_id text,
  owner_bind_code_hash text,
  owner_bind_expires_at integer,
  group_bind_code_hash text not null,
  group_bind_expires_at integer not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (account_id, avatar_id),
  unique (integration_id),
  unique (bot_user_id),
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists swarm_hosted_telegram_integrations_status_idx
  on swarm_hosted_telegram_integrations (status, updated_at);

create table if not exists swarm_hosted_telegram_chats (
  integration_id text not null,
  account_id text not null,
  avatar_id text not null,
  chat_id text not null,
  chat_type text not null,
  thread_id text not null,
  title text,
  enabled integer not null default 1,
  bound_by text not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (integration_id, chat_id),
  unique (account_id, avatar_id, thread_id),
  foreign key (integration_id)
    references swarm_hosted_telegram_integrations(integration_id) on delete cascade,
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create table if not exists swarm_hosted_telegram_updates (
  integration_id text not null,
  update_id text not null,
  account_id text not null,
  avatar_id text not null,
  chat_id text,
  thread_id text,
  job_id text,
  request_id text,
  status text not null check (
    status in ('received', 'ignored', 'queued', 'processing', 'retry', 'sending', 'completed', 'failed', 'unknown')
  ),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  response_text text,
  telegram_message_id text,
  error_code text,
  created_at integer not null,
  updated_at integer not null,
  completed_at integer,
  primary key (integration_id, update_id),
  unique (job_id),
  foreign key (integration_id)
    references swarm_hosted_telegram_integrations(integration_id) on delete cascade
);

create index if not exists swarm_hosted_telegram_updates_status_idx
  on swarm_hosted_telegram_updates (status, updated_at);

create index if not exists swarm_hosted_telegram_updates_expires_idx
  on swarm_hosted_telegram_updates (created_at);
