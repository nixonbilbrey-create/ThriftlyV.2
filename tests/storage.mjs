#!/usr/bin/env node
// Supabase Storage photo backend — exercised without real credentials.
//
// Two local fakes stand in for the outside world:
//   • a minimal Supabase Storage REST API (POST/GET/DELETE /storage/v1/object/…)
//   • a Gemini endpoint that answers the models-list call and generateContent
// The real server runs against both, so photos.js goes over actual HTTP instead
// of being monkeypatched: upload headers and upsert, read-through for
// /api/photos and the data export, and delete when a draft goes away.
//
// The last two flows are the riskiest ones before cutover: one blocks the drafts
// insert with a SQLite trigger to prove the scan route removes a photo it has
// already stored when the draft row can't be written, and the other runs the
// real local→Storage copy script (scripts/migrate-photos-to-storage.mjs),
// which nothing else exercises.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const PORT = Number(process.env.STORAGE_TEST_PORT || 3131);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = 'data-test/storage';
const DB_PATH = `${TEST_DIR}/storage.db`;
const BUCKET = 'photos-test';
const STORAGE_CHECK_TTL_MS = 200;
const SERVICE_KEY = 'test-service-role-key';

const plainHeaders = { 'content-type': 'application/json' };
const authHeaders = (token) => ({ ...plainHeaders, authorization: `Bearer ${token}` });
const json = async (res) => { try { return await res.json(); } catch { return {}; } };

// ---------- fakes ----------
// One loopback server on a random port, returning its origin.
function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Minimal Supabase Storage API: the subset photos.js calls, and it enforces the
// contract the real service enforces (service-role bearer, known bucket). A
// client that stops sending them fails here instead of passing on a recorded
// header nobody asserted.
function startFakeStorage() {
  const objects = new Map(); // object name -> { bytes, contentType }
  const requests = [];       // { method, path, auth, upsert, contentType }
  let failing = false;

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      const auth = req.headers.authorization || null;
      requests.push({
        method: req.method,
        path: url.pathname,
        auth,
        upsert: req.headers['x-upsert'] || null,
        contentType: req.headers['content-type'] || null,
      });

      // Test control plane: simulate a Storage outage on demand.
      if (url.pathname === '/__control/fail') {
        failing = body.toString('utf8').trim() !== 'none';
        res.writeHead(204);
        return res.end();
      }

      // GET /storage/v1/bucket/<name> — what checkStorage() calls to prove the
      // bucket exists and the key is accepted, as the real service does.
      const bucketMatch = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(url.pathname);
      if (bucketMatch) {
        if (auth !== `Bearer ${SERVICE_KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'InvalidJWT' }));
        }
        if (failing) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end('storage is down');
        }
        const wanted = decodeURIComponent(bucketMatch[1]);
        if (wanted !== BUCKET) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Bucket not found', statusCode: '404' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: BUCKET, name: BUCKET, public: false }));
      }

      const match = /^\/storage\/v1\/object\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unknown route' }));
      }
      if (auth !== `Bearer ${SERVICE_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'InvalidJWT' }));
      }
      const bucket = decodeURIComponent(match[1]);
      const name = decodeURIComponent(match[2]);
      if (bucket !== BUCKET) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `bucket not found: ${bucket}` }));
      }
      if (failing) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('storage is down');
      }

      if (req.method === 'POST') {
        if (!body.length) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'empty object' }));
        }
        // Upsert semantics: writing the same name replaces it, like Supabase.
        objects.set(name, { bytes: body, contentType: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ Key: `${bucket}/${name}` }));
      }
      if (req.method === 'GET') {
        const object = objects.get(name);
        if (!object) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Object not found' }));
        }
        res.writeHead(200, { 'content-type': object.contentType });
        return res.end(object.bytes);
      }
      if (req.method === 'DELETE') {
        const existed = objects.delete(name);
        res.writeHead(existed ? 200 : 404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(existed ? { message: 'deleted' } : { error: 'Object not found' }));
      }
      res.writeHead(405);
      res.end();
    });
  };

  return listen(handler).then(({ server, url }) => ({ server, url, objects, requests }));
}

// ---------- fake Gemini ----------
// Answers the two calls the app makes: a models list (key validation) and
// generateContent (the analysis behind /api/scan).
function startFakeGemini() {
  const requests = [];
  const analysis = {
    item_type: 'wool scarf',
    brand: 'Acme',
    category: 'accessories',
    color: 'grey',
    material: 'wool',
    condition: 'Good',
    condition_notes: 'light pilling at the edges',
    estimated_price_low: 18,
    estimated_price_high: 34,
    currency: 'USD',
    confidence: 'medium',
    reasoning: 'Comparable wool accessories sell in this range.',
    suggested_title: 'Grey Wool Scarf',
    suggested_keywords: ['scarf', 'wool', 'grey', 'winter'],
  };

  const handler = (req, res) => {
    req.resume(); // no response depends on the request body
    req.on('end', () => {
      requests.push({ path: req.url, key: req.headers['x-goog-api-key'] || null });

      if (req.method === 'GET' && req.url === '/v1beta/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'models/test-model' }] }));
      }
      if (req.method === 'POST' && /\/v1beta\/models\/[^/]+:generateContent$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }],
        }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown route ${req.method} ${req.url}` } }));
    });
  };

  return listen(handler).then(({ server, url }) => ({ server, url, requests }));
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function photoForm(bytes) {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'item.jpg');
  return form;
}

// ---------- photos.js against the fake Storage API ----------
async function storageClientChecks(storage) {
  // Point the module at the fake before anything is called; Storage config is
  // read per call, so no module reload is needed.
  process.env.SUPABASE_URL = storage.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.SUPABASE_STORAGE_BUCKET = BUCKET;
  const { savePhoto, putPhoto, readPhoto, deletePhoto, storageEnabled } = await import('../photos.js');

  assert.equal(storageEnabled(), true, 'URL + service key must select the Storage backend');

  storage.objects.clear();
  storage.requests.length = 0;

  const saved = await savePhoto(Buffer.from('first-bytes'), 'image/jpeg');
  assert.match(saved.photoId, /^[a-f0-9]{32}\.jpg$/, 'photo ids keep their unguessable shape');
  assert.equal(saved.url, `/api/photos/${saved.photoId}`, 'clients only ever see a same-origin URL');
  assert.deepEqual(storage.objects.get(saved.photoId).bytes, Buffer.from('first-bytes'), 'upload stores the bytes');
  const upload = storage.requests.at(-1);
  assert.equal(upload.path, `/storage/v1/object/${BUCKET}/${saved.photoId}`, 'the configured bucket is used');
  assert.equal(upload.auth, `Bearer ${SERVICE_KEY}`, 'Storage calls are authenticated with the service key');
  assert.equal(upload.upsert, 'true', 'uploads upsert, so a retried copy is safe');

  const read = await readPhoto(saved.photoId);
  assert.deepEqual(read.buffer, Buffer.from('first-bytes'), 'read returns the stored bytes');
  assert.equal(read.mimetype, 'image/jpeg');

  // Upsert: the same id is rewritten in place (what the local→Storage copy does).
  await putPhoto(saved.photoId, Buffer.from('second-bytes'), 'image/png');
  assert.deepEqual(storage.objects.get(saved.photoId).bytes, Buffer.from('second-bytes'), 'putPhoto overwrites in place');
  const rewrites = storage.requests.filter((r) => r.method === 'POST' && r.path.endsWith(saved.photoId));
  assert.equal(rewrites.length, 2, 'the rewrite targets the same object id');
  assert.equal(rewrites.at(-1).contentType, 'image/png', 'and carries the new content type');

  // A missing object is a normal answer, not an error.
  assert.equal(await readPhoto('f'.repeat(32) + '.jpg'), null, 'missing object reads as null');

  // Invalid ids are rejected before any HTTP call is made.
  const callsBefore = storage.requests.length;
  assert.equal(await readPhoto('../../etc/passwd'), null, 'path traversal never reads');
  assert.equal(await deletePhoto('not-a-photo-id'), false, 'junk ids never delete');
  assert.equal(storage.requests.length, callsBefore, 'invalid ids are rejected locally, with no request');

  // Delete is idempotent: true the first time, false once it is gone.
  assert.equal(await deletePhoto(saved.photoId), true, 'deleting a stored object reports true');
  assert.equal(storage.objects.has(saved.photoId), false, 'the object is gone from the bucket');
  assert.equal(await deletePhoto(saved.photoId), false, 'a second delete reports nothing was there');

  // A Storage failure must surface, never be swallowed.
  await fetch(`${storage.url}/__control/fail`, { method: 'POST', body: 'all' });
  await assert.rejects(() => readPhoto('a'.repeat(32) + '.jpg'), /Storage read failed/, 'read errors propagate');
  await assert.rejects(
    () => putPhoto('b'.repeat(32) + '.jpg', Buffer.from('x'), 'image/jpeg'),
    /Storage upload failed/,
    'upload errors propagate',
  );
  await fetch(`${storage.url}/__control/fail`, { method: 'POST', body: 'none' });
}

// ---------- the real server, pointed at both fakes ----------
function startApp(storage, gemini) {
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      BASE_URL: BASE,
      // Local-only dependencies: the app must never reach a real Supabase,
      // Gemini or SMTP during this test, even if .env has credentials.
      DATABASE_URL: '',
      DB_FORCE_SQLITE: '1',
      SUPABASE_URL: storage.url,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SUPABASE_STORAGE_BUCKET: BUCKET,
      // Short TTL so the cache expiring is observable inside a test run.
      STORAGE_CHECK_TTL_MS: String(STORAGE_CHECK_TTL_MS),
      GEMINI_API_BASE: `${gemini.url}/v1beta`,
      GEMINI_MODEL: 'test-model',
      SMTP_HOST: '',
      TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET: '',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitForServer(child, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${BASE}/api/ready`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

async function apiFlows(storage, gemini) {
  // Account, verified through the dev link (no SMTP configured).
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'storage@test.dev', password: 'storage-pass-1', agree: true }),
  });
  const signupBody = await json(signup);
  assert.equal(signup.status, 201, `signup -> ${signup.status} ${JSON.stringify(signupBody)}`);
  assert.ok((await fetch(signupBody.devVerifyLink)).ok, 'verification link must work');
  const login = await json(await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'storage@test.dev', password: 'storage-pass-1' }),
  }));
  assert.ok(login.token, 'login must issue a session token');
  const token = login.token;

  // The key is validated against the fake's models endpoint, then stored encrypted.
  const keyRes = await fetch(`${BASE}/api/account/gemini-key`, {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ apiKey: 'fake-gemini-key-abc123' }),
  });
  assert.equal(keyRes.status, 200, 'key validation must succeed against the fake Gemini');
  assert.ok(
    gemini.requests.some((r) => r.path === '/v1beta/models' && r.key === 'fake-gemini-key-abc123'),
    "the user's own key is what reaches Gemini",
  );
  assert.ok(
    !gemini.requests.some((r) => r.path.includes('generateContent')),
    'connecting a key must not spend generation quota',
  );

  storage.objects.clear();
  storage.requests.length = 0;

  const jpeg = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#7a8f9c' } })
    .jpeg({ quality: 80 }).toBuffer();

  // ---- scan: resize → Gemini → Storage → draft row ----
  const scan = await fetch(`${BASE}/api/scan`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: photoForm(jpeg),
  });
  const draft = await json(scan);
  assert.equal(scan.status, 201, `scan -> ${scan.status} ${JSON.stringify(draft)}`);
  assert.match(draft.thumb, /^\/api\/photos\/[a-f0-9]{32}\.jpg$/, 'the draft stores a same-origin photo URL');
  const photoId = draft.thumb.split('/').pop();

  const stored = storage.objects.get(photoId);
  assert.ok(stored, 'the resized photo was uploaded to Storage');
  const upload = storage.requests.find((r) => r.method === 'POST' && r.path.endsWith(photoId));
  assert.ok(upload, 'the upload went through the Storage API');
  assert.equal(upload.path, `/storage/v1/object/${BUCKET}/${photoId}`, 'the configured bucket is used');
  assert.equal(upload.auth, `Bearer ${SERVICE_KEY}`, 'the server authenticates with the service-role key');
  assert.equal(upload.upsert, 'true', 'uploads upsert');
  assert.equal(upload.contentType, 'image/jpeg', 'the normalized image is stored as jpeg');
  const storedMeta = await sharp(stored.bytes).metadata();
  assert.equal(storedMeta.format, 'jpeg', 'the stored object is a jpeg');
  assert.ok(
    Math.max(storedMeta.width, storedMeta.height) <= 1400,
    `the stored image is capped at 1400px (got ${storedMeta.width}x${storedMeta.height})`,
  );
  assert.ok(
    gemini.requests.some((r) => r.path === '/v1beta/models/test-model:generateContent' && r.key === 'fake-gemini-key-abc123'),
    'the scan calls the configured model with the user key',
  );

  // ---- serving reads back from Storage ----
  const getsBefore = storage.requests.filter((r) => r.method === 'GET').length;
  const served = await fetch(`${BASE}${draft.thumb}`);
  assert.equal(served.status, 200, 'the photo route serves the Storage object');
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(
    Buffer.from(await served.arrayBuffer()), stored.bytes,
    'the served bytes are exactly what Storage holds',
  );
  assert.equal(
    storage.requests.filter((r) => r.method === 'GET').length - getsBefore, 1,
    'serving the photo read that object exactly once',
  );

  // ---- export reads the same object back ----
  const exported = await json(await fetch(`${BASE}/api/account/export`, { headers: authHeaders(token) }));
  assert.ok(exported.photos[photoId], 'the data export includes the Storage photo');
  assert.deepEqual(
    Buffer.from(exported.photos[photoId].base64, 'base64'), stored.bytes,
    'the exported photo bytes match what Storage holds',
  );

  // ---- deleting the draft deletes the object ----
  const del = await fetch(`${BASE}/api/drafts/${draft.id}`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(del.status, 204, 'draft delete must 204');
  assert.equal(storage.objects.has(photoId), false, 'deleting a draft removes its Storage object');
  assert.ok(
    storage.requests.some((r) => r.method === 'DELETE' && r.path.endsWith(photoId)),
    'the removal is an HTTP DELETE on the object',
  );
  assert.equal((await fetch(`${BASE}${draft.thumb}`)).status, 404, 'the deleted photo no longer serves');
  return { token, jpeg };
}

// ---------- readiness proves the bucket, not just the env vars ----------
// Credentials existing is not the same as the bucket answering. Readiness has to
// report 'ok' while Storage responds and 503 when it stops, driven here through
// the fake's control plane so a dead bucket can't pass as healthy.
async function readinessProvesBucket(storage) {
  // Count what actually reaches Storage: /api/ready is public, so a probe must
  // not cost a Supabase request every time.
  const bucketCalls = () => storage.requests.filter((r) => r.path.startsWith('/storage/v1/bucket/')).length;
  const settle = () => sleep(STORAGE_CHECK_TTL_MS + 150);

  const before = bucketCalls();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/api/ready`);
    assert.equal(res.status, 200, 'readiness ok while Storage answers');
    const body = await json(res);
    assert.equal(body.storage, 'ok', 'readiness reports the bucket as ok');
    assert.equal(body.db, 'sqlite', 'the payload still names the database backend');
  }
  assert.equal(bucketCalls() - before, 1, '5 probes inside the TTL must cost one Storage call, not five');

  // A burst arriving at a cold cache must also cost one call: concurrent probes
  // share the in-flight check rather than each starting their own.
  await settle();
  const burstStart = bucketCalls();
  const burst = await Promise.all(Array.from({ length: 5 }, () => fetch(`${BASE}/api/ready`)));
  assert.deepEqual(burst.map((r) => r.status), [200, 200, 200, 200, 200], 'concurrent probes all answer');
  assert.equal(bucketCalls() - burstStart, 1, '5 concurrent probes must share one Storage call');

  await fetch(`${storage.url}/__control/fail`, { method: 'POST', body: 'yes' });
  try {
    // Still inside the TTL: the cached success stands, and nothing is re-probed.
    const cached = bucketCalls();
    assert.equal((await fetch(`${BASE}/api/ready`)).status, 200, 'the cached result holds until it expires');
    assert.equal(bucketCalls(), cached, 'no Storage call inside the TTL');

    await settle();
    const down = await fetch(`${BASE}/api/ready`);
    assert.equal(down.status, 503, 'an unreachable bucket must fail readiness once the cache expires');
    const body = await json(down);
    assert.equal(body.storage, 'unreachable', 'readiness names Storage as the broken dependency');
    assert.match(body.detail || '', /bucket/, 'the detail names the bucket check');

    const whileDown = bucketCalls();
    assert.equal((await fetch(`${BASE}/api/ready`)).status, 503, 'a cached failure keeps failing');
    assert.equal(bucketCalls(), whileDown, 'a cached failure is not re-probed inside the TTL');
  } finally {
    await fetch(`${storage.url}/__control/fail`, { method: 'POST', body: 'none' });
  }

  await settle();
  assert.equal((await fetch(`${BASE}/api/ready`)).status, 200, 'readiness recovers when Storage does');
}

// ---------- the orphan-cleanup path ----------
// Block the drafts insert at the database, then scan again: the photo is
// uploaded first, so only the cleanup in server.js can remove it.
async function failedDraftCleanupFlow(storage, token, jpeg) {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(DB_PATH);
  raw.exec(`
    CREATE TRIGGER storage_test_block_drafts
    BEFORE INSERT ON drafts
    BEGIN
      SELECT RAISE(ABORT, 'draft insert blocked by test');
    END;
  `);
  raw.close();

  try {
    storage.requests.length = 0;
    const objectsBefore = storage.objects.size;

    const failed = await fetch(`${BASE}/api/scan`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: photoForm(jpeg),
    });
    assert.equal(failed.status, 500, 'a failed draft insert is a 5xx');
    assert.match((await json(failed)).error || '', /Something went wrong/, 'the client gets the generic 5xx message');

    assert.equal(storage.objects.size, objectsBefore, 'no photo is left behind when the draft insert fails');

    const uploads = storage.requests.filter((r) => r.method === 'POST');
    const deletes = storage.requests.filter((r) => r.method === 'DELETE');
    assert.equal(uploads.length, 1, 'the scan uploaded exactly one photo before failing');
    assert.equal(deletes.length, 1, 'and cleaned up exactly that one');
    const uploadedId = uploads[0].path.split('/').pop();
    assert.equal(
      deletes[0].path, `/storage/v1/object/${BUCKET}/${uploadedId}`,
      'the cleanup deletes the object the scan just stored',
    );
    assert.equal(deletes[0].auth, `Bearer ${SERVICE_KEY}`, 'the cleanup call is authenticated too');
  } finally {
    const cleanup = new Database(DB_PATH);
    cleanup.exec('DROP TRIGGER IF EXISTS storage_test_block_drafts');
    cleanup.close();
  }
}

// ---------- local → Storage photo migration ----------
// scripts/migrate-photos-to-storage.mjs is the step that has to be right before
// cutover: it reads photo ids out of the SQLite drafts and uploads the matching
// files. Run the real script against the same fake bucket, with a throwaway
// database and photo directory in the shape the cutover will meet.
async function migrationFlow(storage) {
  const dir = `${TEST_DIR}/migrate`;
  const photosDir = `${dir}/photos`;
  const dbPath = `${dir}/migrate.db`;
  mkdirSync(photosDir, { recursive: true });

  const jpegBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#334455' } })
    .jpeg().toBuffer();
  const pngBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#998877' } })
    .png().toBuffer();
  const jpegId = `${'a'.repeat(32)}.jpg`;
  const pngId = `${'b'.repeat(32)}.png`;
  const missingId = `${'c'.repeat(32)}.jpg`;
  writeFileSync(`${photosDir}/${jpegId}`, jpegBytes);
  writeFileSync(`${photosDir}/${pngId}`, pngBytes);

  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.exec(`
    create table drafts (
      id text primary key, user_id text, analysis text not null, thumb text,
      listings text not null default '{}', selected text not null default '[]',
      created_at integer not null, updated_at integer not null
    );
  `);
  const insert = db.prepare(
    'insert into drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  const addDraft = (id, thumb) => insert.run(id, 'user1', '{}', thumb, '{}', '[]', now, now);
  addDraft('draft-jpeg', `/api/photos/${jpegId}`);
  addDraft('draft-png', `/api/photos/${pngId}`);
  addDraft('draft-no-photo', null); // nothing to copy
  addDraft('draft-legacy-data-uri', 'data:image/jpeg;base64,AAAA'); // pre-file-URL drafts
  db.close();

  // Async on purpose: the fake bucket lives in this process, so a synchronous
  // spawn would block the event loop the script's uploads need answering by.
  const runScript = (extraEnv = {}) => new Promise((resolve) => {
    const child = spawn('node', ['scripts/migrate-photos-to-storage.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: '',
        DB_PATH: dbPath,
        PHOTOS_DIR: photosDir,
        SUPABASE_URL: storage.url,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        SUPABASE_STORAGE_BUCKET: BUCKET,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  storage.objects.clear();
  storage.requests.length = 0;

  // Happy path: only real photo ids are copied, byte for byte, under the same
  // ids the drafts already point at — so /api/photos URLs keep working.
  const first = await runScript();
  assert.equal(first.status, 0, `the copy must succeed: ${first.stderr || first.stdout}`);
  assert.match(first.stdout, /2 uploaded, 0 missing, 2 referenced/, 'summary counts real photos only');
  assert.deepEqual(storage.objects.get(jpegId)?.bytes, jpegBytes, 'the jpeg is copied byte for byte');
  assert.deepEqual(storage.objects.get(pngId)?.bytes, pngBytes, 'the png is copied byte for byte');
  assert.equal(storage.objects.size, 2, 'null and legacy data: thumbs are skipped');

  const jpegUpload = storage.requests.find((r) => r.method === 'POST' && r.path.endsWith(jpegId));
  const pngUpload = storage.requests.find((r) => r.method === 'POST' && r.path.endsWith(pngId));
  assert.equal(jpegUpload.path, `/storage/v1/object/${BUCKET}/${jpegId}`, 'the object keeps the photo id the draft uses');
  assert.equal(jpegUpload.contentType, 'image/jpeg', 'content type comes from the file extension');
  assert.equal(pngUpload.contentType, 'image/png', 'png photos keep their type');
  assert.equal(jpegUpload.auth, `Bearer ${SERVICE_KEY}`, 'the copy authenticates with the service key');

  // The point of keeping the id: a draft's existing /api/photos URL resolves to
  // the copied object with no database change, served by the running app out of
  // the bucket. The missing id is the negative control — it must not resolve.
  const served = await fetch(`${BASE}/api/photos/${jpegId}`);
  assert.equal(served.status, 200, 'a draft URL written before the copy still serves');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpegBytes, 'and serves the migrated bytes');
  assert.equal(
    (await fetch(`${BASE}/api/photos/${missingId}`)).status, 404,
    'a photo that was never copied does not resolve — so the 200 above means something',
  );

  // A draft whose file is gone fails the run after copying what it can — the
  // runbook relies on that non-zero exit to notice a partial copy.
  const withMissing = new Database(dbPath);
  withMissing.prepare(
    'insert into drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('draft-missing', 'user1', '{}', `/api/photos/${missingId}`, '{}', '[]', now, now);
  withMissing.close();

  const second = await runScript();
  assert.equal(second.status, 1, 'a missing file must fail the run');
  assert.match(second.stderr, new RegExp(`${missingId}.*not on disk`), 'the missing photo is named');
  assert.match(second.stdout, /2 uploaded, 1 missing, 3 referenced/, 'the summary counts the miss');

  // Idempotent: the second run re-uploads the two resolvable photos (upsert) and
  // still uploads nothing for the missing one.
  const posts = storage.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 4, 'two runs × two resolvable photos — the missing file is never uploaded');
  assert.equal(posts.filter((r) => r.path.endsWith(jpegId)).length, 2, 'the re-run upserts the same id again');
  assert.deepEqual(storage.objects.get(jpegId).bytes, jpegBytes, 'bytes are unchanged by the re-run');

  // Without Storage credentials it stops before touching anything.
  storage.requests.length = 0;
  const noCreds = await runScript({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
  assert.equal(noCreds.status, 1, 'missing credentials must fail');
  assert.match(noCreds.stderr, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required/);
  assert.equal(storage.requests.length, 0, 'a credential-less run makes no Storage call at all');
}

// ---------- shell ----------
// Start from a clean directory: an aborted earlier run may have left its database
// behind, and a duplicate-account error would hide the real failure.
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
const storage = await startFakeStorage();
const gemini = await startFakeGemini();
let child = null;
let failed = false;
try {
  console.log('storage backend test (fake Supabase Storage + fake Gemini)');
  let step = Date.now();
  await storageClientChecks(storage);
  console.log(`  ok   photos.js upload/read/delete/upsert/errors over HTTP (${Date.now() - step}ms)`);

  step = Date.now();
  child = startApp(storage, gemini);
  await waitForServer(child);
  const { token, jpeg } = await apiFlows(storage, gemini);
  console.log(`  ok   scan → upload → serve → export → draft delete (${Date.now() - step}ms)`);

  step = Date.now();
  await readinessProvesBucket(storage);
  console.log(`  ok   /api/ready proves the bucket answers, 503 when it does not (${Date.now() - step}ms)`);

  step = Date.now();
  await failedDraftCleanupFlow(storage, token, jpeg);
  // Storage mode must never also fall back to writing photo files.
  assert.equal(
    existsSync(`${TEST_DIR}/photos`), false,
    'no local photo directory is created when Storage is configured',
  );
  console.log(`  ok   failed draft insert removes the stored photo (${Date.now() - step}ms)`);

  step = Date.now();
  await migrationFlow(storage);
  console.log(`  ok   local→Storage photo copy script (${Date.now() - step}ms)`);
} catch (err) {
  failed = true;
  console.error('STORAGE TEST FAIL:', err.stack || err);
} finally {
  if (child) child.kill('SIGTERM');
  await sleep(300);
  await closeServer(storage.server);
  await closeServer(gemini.server);
  rmSync(TEST_DIR, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
