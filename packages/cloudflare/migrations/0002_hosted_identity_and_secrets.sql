create table if not exists swarm_accounts (
  account_id text primary key,
  created_at integer not null
);

create table if not exists swarm_identities (
  provider text not null,
  provider_id text not null,
  account_id text not null,
  created_at integer not null,
  primary key (provider, provider_id),
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_identities_account_idx
  on swarm_identities (account_id);

create table if not exists swarm_auth_challenges (
  nonce_hash text primary key,
  wallet_address text not null,
  message text not null,
  created_at integer not null,
  expires_at integer not null
);

create index if not exists swarm_auth_challenges_expires_idx
  on swarm_auth_challenges (expires_at);

create table if not exists swarm_auth_rate_limits (
  rate_key text primary key,
  window_start integer not null,
  count integer not null,
  expires_at integer not null
);

create index if not exists swarm_auth_rate_limits_expires_idx
  on swarm_auth_rate_limits (expires_at);

create table if not exists swarm_sessions (
  session_hash text primary key,
  account_id text not null,
  wallet_address text not null,
  created_at integer not null,
  expires_at integer not null,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_sessions_account_idx
  on swarm_sessions (account_id);

create index if not exists swarm_sessions_expires_idx
  on swarm_sessions (expires_at);

create table if not exists swarm_user_secrets (
  account_id text not null,
  tenant_id text not null default '',
  name text not null,
  envelope text not null,
  key_version text not null,
  updated_at integer not null,
  primary key (account_id, tenant_id, name),
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create table if not exists swarm_oauth_transactions (
  state_hash text primary key,
  account_id text not null,
  session_hash text not null,
  provider text not null,
  verifier_envelope text not null,
  created_at integer not null,
  expires_at integer not null,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_oauth_transactions_expires_idx
  on swarm_oauth_transactions (expires_at);
