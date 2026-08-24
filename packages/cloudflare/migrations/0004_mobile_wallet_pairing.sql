create table if not exists swarm_mobile_auth_pairings (
  pairing_hash text primary key,
  poll_token_hash text not null,
  status text not null check (status in ('pending', 'approved', 'consumed')),
  account_id text,
  wallet_address text,
  created_at integer not null,
  expires_at integer not null,
  approved_at integer,
  consumed_at integer,
  foreign key (account_id) references swarm_accounts(account_id) on delete cascade
);

create index if not exists swarm_mobile_auth_pairings_expires_idx
  on swarm_mobile_auth_pairings (expires_at);
