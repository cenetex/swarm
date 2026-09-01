alter table swarm_sessions
  add column auth_provider text not null default 'wallet'
  check (auth_provider in ('wallet', 'passkey'));

create table if not exists swarm_passkeys (
  credential_id text primary key,
  account_id text not null,
  webauthn_user_id text not null,
  public_key text not null,
  counter integer not null default 0,
  device_type text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up integer not null check (backed_up in (0, 1)),
  transports text not null default '[]',
  created_at integer not null,
  last_used_at integer,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_passkeys_account_idx
  on swarm_passkeys (account_id, created_at);

create table if not exists swarm_passkey_challenges (
  handle_hash text primary key,
  purpose text not null check (purpose in ('registration', 'authentication')),
  account_id text,
  challenge text not null,
  webauthn_user_id text,
  created_at integer not null,
  expires_at integer not null,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_passkey_challenges_expires_idx
  on swarm_passkey_challenges (expires_at);
