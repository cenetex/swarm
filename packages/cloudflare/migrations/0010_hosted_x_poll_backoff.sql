alter table swarm_hosted_x_integrations add column poll_after integer;

create index if not exists swarm_hosted_x_integrations_due_idx
  on swarm_hosted_x_integrations (status, poll_after, last_polled_at);
