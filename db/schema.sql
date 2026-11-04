-- Thriftly — Postgres schema (Supabase)
-- Mirrors the SQLite schema in db.js one-for-one. Timestamps stay as epoch
-- milliseconds (bigint) because the app compares them to Date.now(); JSON
-- columns are jsonb so the API can return them without re-parsing.
--
-- Apply with:
--   psql "$DATABASE_URL" -f db/schema.sql
-- or paste into the Supabase SQL editor.
--
-- No foreign keys or cascades on purpose: the SQLite schema has none, and the
-- application deletes child rows explicitly. Adding FKs later is safe once the
-- existing data is known-clean.

create table if not exists users (
  id                    text primary key,
  email                 text not null unique,
  password_hash         text not null,
  email_verified        boolean not null default false,
  consent_version       text,
  consent_at            bigint,
  gemini_key_enc        text,
  gemini_key_valid      boolean not null default false,
  gemini_key_updated_at bigint,
  created_at            bigint not null
);

create table if not exists sessions (
  token       text primary key,
  user_id     text not null,
  created_at  bigint not null,
  expires_at  bigint not null
);

create table if not exists email_verifications (
  token       text primary key,
  user_id     text not null,
  created_at  bigint not null,
  expires_at  bigint not null
);

create table if not exists password_resets (
  token       text primary key,
  user_id     text not null,
  created_at  bigint not null,
  expires_at  bigint not null
);

create table if not exists drafts (
  id          text primary key,
  user_id     text not null,
  analysis    jsonb not null,
  thumb       text,
  listings    jsonb not null default '{}'::jsonb,
  selected    jsonb not null default '[]'::jsonb,
  created_at  bigint not null,
  updated_at  bigint not null
);

create index if not exists idx_drafts_user on drafts(user_id);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expires on sessions(expires_at);
create index if not exists idx_email_verifications_user on email_verifications(user_id);
create index if not exists idx_email_verifications_expires on email_verifications(expires_at);
create index if not exists idx_password_resets_user on password_resets(user_id);
create index if not exists idx_password_resets_expires on password_resets(expires_at);
