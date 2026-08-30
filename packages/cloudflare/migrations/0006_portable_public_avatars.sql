alter table swarm_hosted_avatars add column slug text;
alter table swarm_hosted_avatars add column visibility text not null default 'public'
  check (visibility in ('public', 'private'));
alter table swarm_hosted_avatars add column listed integer not null default 1
  check (listed in (0, 1));
alter table swarm_hosted_avatars add column current_revision_id text;
alter table swarm_hosted_avatars add column current_bundle_key text;

-- Existing POC avatars had no publication choice. Preserve them as private until
-- their owner explicitly publishes a later revision. The public defaults above
-- apply only to rows created after this migration.
update swarm_hosted_avatars
set slug = avatar_id, visibility = 'private', listed = 0
where current_revision_id is null;

create unique index if not exists swarm_hosted_avatars_slug_idx
  on swarm_hosted_avatars (slug);

create index if not exists swarm_hosted_avatars_catalog_idx
  on swarm_hosted_avatars (visibility, listed, updated_at desc);

create table if not exists swarm_hosted_avatar_revisions (
  account_id text not null,
  avatar_id text not null,
  revision_id text not null,
  sha256 text not null,
  bundle_key text not null,
  bundle_json text not null,
  previous_revision_id text,
  publicly_accessible integer not null default 0 check (publicly_accessible in (0, 1)),
  created_at integer not null,
  primary key (avatar_id, revision_id),
  unique (sha256),
  foreign key (account_id, avatar_id)
    references swarm_hosted_avatars(account_id, avatar_id) on delete cascade
);

create index if not exists swarm_hosted_avatar_revisions_created_idx
  on swarm_hosted_avatar_revisions (avatar_id, created_at desc);

pragma optimize;
