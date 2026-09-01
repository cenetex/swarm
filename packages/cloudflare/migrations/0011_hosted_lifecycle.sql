create table if not exists swarm_hosted_lifecycles (
  account_id text primary key,
  billing_json text not null,
  runtime_json text not null,
  created_at integer not null,
  updated_at integer not null,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create table if not exists swarm_hosted_lifecycle_events (
  event_scope text not null check (event_scope in ('billing', 'runtime')),
  provider text not null,
  event_id text not null,
  account_id text not null,
  occurred_at integer not null,
  received_at integer not null,
  primary key (event_scope, provider, event_id),
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_hosted_lifecycle_events_account_idx
  on swarm_hosted_lifecycle_events (account_id, occurred_at desc);

create index if not exists swarm_hosted_lifecycles_updated_idx
  on swarm_hosted_lifecycles (updated_at);
