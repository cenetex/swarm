create table if not exists swarm_hosted_x_integrations (
  account_id text not null,
  avatar_id text not null,
  integration_id text not null,
  x_user_id text not null,
  username text not null,
  status text not null check (status in ('connected', 'reauth_required')),
  since_id text,
  last_polled_at integer,
  last_error_code text,
  created_at integer not null,
  updated_at integer not null,
  primary key (account_id, avatar_id),
  unique (integration_id),
  unique (x_user_id),
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists swarm_hosted_x_integrations_poll_idx
  on swarm_hosted_x_integrations (status, last_polled_at, updated_at);

create table if not exists swarm_hosted_x_oauth_transactions (
  token_hash text primary key,
  account_id text not null,
  avatar_id text not null,
  session_hash text not null,
  created_at integer not null,
  expires_at integer not null,
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists swarm_hosted_x_oauth_expires_idx
  on swarm_hosted_x_oauth_transactions (expires_at);

create table if not exists swarm_hosted_x_conversations (
  integration_id text not null,
  account_id text not null,
  avatar_id text not null,
  conversation_id text not null,
  thread_id text not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (integration_id, conversation_id),
  unique (account_id, avatar_id, thread_id),
  foreign key (integration_id)
    references swarm_hosted_x_integrations(integration_id) on delete cascade,
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create table if not exists swarm_hosted_x_mentions (
  integration_id text not null,
  mention_id text not null,
  account_id text not null,
  avatar_id text not null,
  thread_id text not null,
  author_id text not null,
  author_username text,
  conversation_id text not null,
  request_id text not null,
  job_id text not null,
  status text not null check (
    status in ('received', 'queued', 'processing', 'retry', 'sending', 'completed', 'failed', 'unknown')
  ),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  response_text text,
  reply_post_id text,
  error_code text,
  source_text text not null,
  created_at integer not null,
  updated_at integer not null,
  completed_at integer,
  primary key (integration_id, mention_id),
  unique (job_id),
  unique (account_id, avatar_id, request_id),
  foreign key (integration_id)
    references swarm_hosted_x_integrations(integration_id) on delete cascade,
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create index if not exists swarm_hosted_x_mentions_status_idx
  on swarm_hosted_x_mentions (status, updated_at);

create index if not exists swarm_hosted_x_mentions_expires_idx
  on swarm_hosted_x_mentions (created_at);
