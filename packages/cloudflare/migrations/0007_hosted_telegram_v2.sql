alter table swarm_hosted_telegram_chats
  add column membership_status text not null default 'member';

alter table swarm_hosted_telegram_chats
  add column last_activity_at integer;

alter table swarm_hosted_telegram_updates
  add column source_message_id text;

alter table swarm_hosted_telegram_updates
  add column message_thread_id text;

create table if not exists swarm_hosted_telegram_topics (
  integration_id text not null,
  account_id text not null,
  avatar_id text not null,
  chat_id text not null,
  message_thread_id text not null,
  thread_id text not null,
  created_at integer not null,
  updated_at integer not null,
  primary key (integration_id, chat_id, message_thread_id),
  unique (account_id, avatar_id, thread_id),
  foreign key (integration_id, chat_id)
    references swarm_hosted_telegram_chats(integration_id, chat_id) on delete cascade,
  foreign key (account_id, avatar_id, thread_id)
    references swarm_hosted_chat_threads(account_id, avatar_id, thread_id) on delete cascade
);

create index if not exists swarm_hosted_telegram_topics_chat_idx
  on swarm_hosted_telegram_topics (integration_id, chat_id, updated_at);
