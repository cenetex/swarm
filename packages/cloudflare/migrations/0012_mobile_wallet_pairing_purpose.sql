alter table swarm_mobile_auth_pairings
  add column purpose text not null default 'sign-in'
  check (purpose in ('sign-in', 'link'));
