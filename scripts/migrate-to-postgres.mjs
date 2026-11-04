#!/usr/bin/env node
// Copy a Thriftly SQLite database into the Postgres schema in db/schema.sql.
// One-way and idempotent: users/drafts upsert by id, token rows are
// insert-if-absent (tokens are immutable). Safe to re-run after a partial copy.
//
// Usage:
//   DATABASE_URL='postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres' \
//     node scripts/migrate-to-postgres.mjs
//
// Env:
//   DATABASE_URL  required — Supabase pooler URI (session mode, port 5432)
//   DB_PATH       optional — default data/thriftly.db
//
// Apply db/schema.sql to the target first. See docs/SUPABASE.md.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = path.resolve(process.env.DB_PATH || 'data/thriftly.db');

function fail(message) {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

if (!DATABASE_URL) fail('DATABASE_URL is required (Supabase pooler connection string)');
if (!fs.existsSync(DB_PATH)) fail(`no SQLite database at ${DB_PATH}`);

const sqlite = new Database(DB_PATH, { readonly: true });
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 1,
  // Supabase requires TLS. Local Postgres URLs with sslmode=disable skip it.
  ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const TABLES = ['users', 'sessions', 'email_verifications', 'password_resets', 'drafts'];

function rows(table) {
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

async function main() {
  const client = await pool.connect();
  try {
    const schema = await client.query("select to_regclass('public.users') as users");
    if (!schema.rows[0].users) {
      fail('target has no users table — apply db/schema.sql first (see docs/SUPABASE.md)');
    }

    await client.query('begin');

    // Users: upsert so a re-run refreshes fields without duplicating.
    for (const row of rows('users')) {
      await client.query(
        `insert into users
           (id, email, password_hash, email_verified, consent_version, consent_at,
            gemini_key_enc, gemini_key_valid, gemini_key_updated_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do update set
           email = excluded.email,
           password_hash = excluded.password_hash,
           email_verified = excluded.email_verified,
           consent_version = excluded.consent_version,
           consent_at = excluded.consent_at,
           gemini_key_enc = excluded.gemini_key_enc,
           gemini_key_valid = excluded.gemini_key_valid,
           gemini_key_updated_at = excluded.gemini_key_updated_at`,
        [
          row.id, row.email, row.password_hash, !!row.email_verified,
          row.consent_version, row.consent_at, row.gemini_key_enc,
          !!row.gemini_key_valid, row.gemini_key_updated_at, row.created_at,
        ],
      );
    }

    // Session / verification / reset tokens are write-once in practice.
    for (const row of rows('sessions')) {
      await client.query(
        'insert into sessions (token, user_id, created_at, expires_at) values ($1,$2,$3,$4) on conflict (token) do nothing',
        [row.token, row.user_id, row.created_at, row.expires_at],
      );
    }
    for (const row of rows('email_verifications')) {
      await client.query(
        'insert into email_verifications (token, user_id, created_at, expires_at) values ($1,$2,$3,$4) on conflict (token) do nothing',
        [row.token, row.user_id, row.created_at, row.expires_at],
      );
    }
    for (const row of rows('password_resets')) {
      await client.query(
        'insert into password_resets (token, user_id, created_at, expires_at) values ($1,$2,$3,$4) on conflict (token) do nothing',
        [row.token, row.user_id, row.created_at, row.expires_at],
      );
    }

    // Drafts: JSON columns are text in SQLite; pass parsed objects for jsonb.
    for (const row of rows('drafts')) {
      await client.query(
        `insert into drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           user_id = excluded.user_id,
           analysis = excluded.analysis,
           thumb = excluded.thumb,
           listings = excluded.listings,
           selected = excluded.selected,
           updated_at = excluded.updated_at`,
        [
          row.id, row.user_id, JSON.parse(row.analysis), row.thumb,
          JSON.parse(row.listings), JSON.parse(row.selected),
          row.created_at, row.updated_at,
        ],
      );
    }

    // Verify counts before committing — a silent partial copy is worse than a failure.
    for (const table of TABLES) {
      const source = rows(table).length;
      const target = Number((await client.query(`select count(*)::int as n from ${table}`)).rows[0].n);
      if (target < source) throw new Error(`${table}: target has ${target} rows, source has ${source}`);
      console.log(`migrate: ${table.padEnd(20)} ${source} rows copied (target now ${target})`);
    }

    await client.query('commit');
    console.log('migrate: done — set DATABASE_URL for the app and switch the data layer.');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => fail(err.message))
  .finally(() => {
    sqlite.close();
    pool.end();
  });
