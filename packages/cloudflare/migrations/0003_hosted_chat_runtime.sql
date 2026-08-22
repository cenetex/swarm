create table if not exists swarm_hosted_avatars (
  account_id text not null,
  avatar_id text not null,
  default_thread_id text not null,
  name text not null,
  description text,
  persona text,
  status text not null default 'shell',
  created_by text not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (account_id, avatar_id),
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_hosted_avatars_updated_idx
  on swarm_hosted_avatars (account_id, updated_at desc);

create table if not exists swarm_hosted_chat_threads (
  account_id text not null,
  avatar_id text not null,
  thread_id text not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (account_id, avatar_id, thread_id),
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create table if not exists swarm_hosted_chat_messages (
  account_id text not null,
  avatar_id text not null,
  thread_id text not null,
  message_id text not null,
  request_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at integer not null,
  primary key (account_id, message_id),
  unique (account_id, avatar_id, request_id, role),
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create index if not exists swarm_hosted_chat_messages_history_idx
  on swarm_hosted_chat_messages (account_id, avatar_id, thread_id, created_at, message_id);

create table if not exists swarm_hosted_chat_jobs (
  account_id text not null,
  avatar_id text not null,
  thread_id text not null,
  job_id text not null,
  request_id text not null,
  status text not null check (status in ('queued', 'processing', 'retry', 'completed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  error_code text,
  error_message text,
  response_message_id text,
  created_at integer not null,
  updated_at integer not null,
  completed_at integer,
  primary key (account_id, job_id),
  unique (account_id, avatar_id, request_id),
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create index if not exists swarm_hosted_chat_jobs_status_idx
  on swarm_hosted_chat_jobs (status, updated_at);

create index if not exists swarm_hosted_chat_jobs_avatar_idx
  on swarm_hosted_chat_jobs (account_id, avatar_id, created_at desc);

create table if not exists swarm_hosted_chat_rate_limits (
  account_id text primary key,
  window_start integer not null,
  count integer not null,
  expires_at integer not null,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_hosted_chat_rate_limits_expires_idx
  on swarm_hosted_chat_rate_limits (expires_at);
