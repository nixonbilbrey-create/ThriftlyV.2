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
import zlib from 'node:zlib';
import sharp from 'sharp';
import photosModule from '../photos.js';

const PORT = Number(process.env.STORAGE_TEST_PORT || 3131);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = 'data-test/storage';
const DB_PATH = `${TEST_DIR}/storage.db`;
const BUCKET = 'photos-test';
const STORAGE_CHECK_TTL_MS = 200;
// A model ID Google has retired: the fake answers 404 the way the real API does,
// which is the signal gemini.js falls back on.
const RETIRED_MODELS = new Set(['gemini-3.5-flash']);
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
      const generate = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(req.url);
      if (req.method === 'POST' && generate) {
        const model = generate[1];
        if (RETIRED_MODELS.has(model)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.` },
          }));
        }
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

// A zip with stored (uncompressed) members — enough of the format for the
// extractor's central-directory reader, and no dependency to build.
function makeZip(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const size = file.data.length;
    // Real docx/xlsx members are deflated; exercise both storage methods.
    const payload = file.deflate ? zlib.deflateRawSync(file.data) : file.data;
    const method = file.deflate ? 8 : 0;
    const claimed = file.claim || size; // headers can lie; the extractor must not believe them
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(claimed, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    parts.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ---------- the photo hiding inside another file ----------
// A PDF with an embedded JPEG, a docx-style zip with a PNG, and an SVG all have
// to reach the same pipeline as a plain photo; a file with no image in it has to
// say so instead of failing somewhere deeper.
async function containerImageFlow(storage, token) {
  const listDrafts = async () => json(await fetch(`${BASE}/api/drafts`, { headers: authHeaders(token) }));
  const before = await listDrafts();

  const upload = async (bytes, type, name) => {
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type }), name);
    const res = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { res, body: await json(res) };
  };
  const storedMeta = async (thumb) => sharp(storage.objects.get(thumb.split('/').pop()).bytes).metadata();

  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#335577' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c8f53c' } }).png().toBuffer();

  // PDF: the photo is an FF D8 … FF D9 stream between the object markers.
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode >>\nstream\n'),
    jpeg,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
  const fromPdf = await upload(pdf, 'application/pdf', 'receipt.pdf');
  assert.equal(fromPdf.res.status, 201, `a PDF with a photo scans -> ${fromPdf.res.status} ${JSON.stringify(fromPdf.body)}`);
  assert.match(fromPdf.body.thumb, /^\/api\/photos\/[a-f0-9]{32}\.jpg$/, 'the photo found in the PDF becomes the draft thumb');
  const pdfMeta = await storedMeta(fromPdf.body.thumb);
  assert.equal(pdfMeta.format, 'jpeg', 'and is stored as a normalised jpeg');

  // Word/PowerPoint/Excel/EPUB are zips with media inside.
  const docx = makeZip([
    { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    { name: 'word/media/image1.png', data: png, deflate: true },
  ]);
  const fromDocx = await upload(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'listing.docx');
  assert.equal(fromDocx.res.status, 201, `a docx with a photo scans -> ${fromDocx.res.status} ${JSON.stringify(fromDocx.body)}`);
  const docxMeta = await storedMeta(fromDocx.body.thumb);
  assert.equal(docxMeta.format, 'jpeg', 'the image pulled out of the zip is normalised like any photo');

  // SVG is an image, just not a raster one.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#ff5522"/></svg>');
  const fromSvg = await upload(svg, 'image/svg+xml', 'sticker.svg');
  assert.equal(fromSvg.res.status, 201, `an SVG scans -> ${fromSvg.res.status} ${JSON.stringify(fromSvg.body)}`);

  // Nothing to find: a zip of text, and a plain text file.
  const emptyZip = await upload(makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }]), 'application/zip', 'archive.zip');
  assert.equal(emptyZip.res.status, 415, 'a zip with no images is refused');
  assert.match(emptyZip.body.error || '', /No image found/, 'and says no image was found');

  assert.equal((await listDrafts()).length, before.length + 3, 'each successful scan created exactly one draft');

  for (const draft of await listDrafts()) {
    if (before.some((old) => old.id === draft.id)) continue;
    await fetch(`${BASE}/api/drafts/${draft.id}`, { method: 'DELETE', headers: authHeaders(token) });
  }
  assert.equal((await listDrafts()).length, before.length, 'cleanup left the draft list as it was');
}

// ---------- the TTL guard ----------
// A malformed STORAGE_CHECK_TTL_MS used to become NaN, and every comparison
// against NaN is false — the cache would silently stop caching while still
// looking configured. These are pure-function checks so the fallback is pinned
// without needing a server round trip.
function ttlGuardChecks(photos) {
  const { resolveStorageCheckTtl } = photos;
  const fallback = 10000;
  assert.equal(resolveStorageCheckTtl(undefined), fallback, 'unset uses the default');
  assert.equal(resolveStorageCheckTtl(''), fallback, 'blank uses the default');
  assert.equal(resolveStorageCheckTtl('   '), fallback, 'whitespace uses the default');
  assert.equal(resolveStorageCheckTtl('abc'), fallback, 'unparseable uses the default');
  assert.equal(resolveStorageCheckTtl('10s'), fallback, 'a unit suffix is not silently honoured');
  assert.equal(resolveStorageCheckTtl('NaN'), fallback, 'the literal string NaN uses the default');
  assert.equal(resolveStorageCheckTtl('-1'), fallback, 'a negative TTL uses the default');
  assert.equal(resolveStorageCheckTtl('250'), 250, 'a real value is honoured');
  assert.equal(resolveStorageCheckTtl('0'), 0, '0 is allowed, as an explicit opt-out');
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
      // Deliberately a retired ID: every scan in this suite then has to fall back.
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMINI_MODEL_FALLBACKS: 'gemini-3.6-flash,gemini-flash-latest',
      SMTP_HOST: '',
      // This suite drives the verification flow on purpose (it signs up through the
      // dev link); with no relay the app would otherwise skip the gate.
      REQUIRE_EMAIL_VERIFICATION: 'true',
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
    gemini.requests.some((r) => r.path === '/v1beta/models/gemini-3.5-flash:generateContent' && r.key === 'fake-gemini-key-abc123'),
    'the scan tries the configured model first, with the user key',
  );
  assert.ok(
    gemini.requests.some((r) => r.path === '/v1beta/models/gemini-3.6-flash:generateContent' && r.key === 'fake-gemini-key-abc123'),
    'a retired model id falls back to the next candidate instead of failing the scan',
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

// ---------- HEIC, which iPhones shoot by default ----------
// This sharp build cannot decode HEVC (verified: heifsave reports "Unsupported
// compression: hevc"), so a HEIC that reaches the server must be refused with
// instructions — and a HEIC mislabelled as JPEG must be caught by its signature
// rather than slipping through to a vague "couldn't read that image".
function heicBuffer() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('heicmif1', 'ascii'),
  ]);
}

async function heicRejectionFlow(token) {
  const draftCount = async () => (await json(await fetch(`${BASE}/api/drafts`, { headers: { authorization: `Bearer ${token}` } }))).length;
  const before = await draftCount();

  const typed = new FormData();
  typed.append('photo', new Blob([heicBuffer()], { type: 'image/heic' }), 'IMG_0001.HEIC');
  const res = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: typed });
  assert.equal(res.status, 415, 'a HEIC upload is refused as unsupported media');
  const body = await json(res);
  assert.match(body.error || '', /HEIC/i, 'the error names HEIC');
  assert.match(body.error || '', /Most Compatible|JPEG/i, 'and tells the user what to do instead');

  const mislabelled = new FormData();
  mislabelled.append('photo', new Blob([heicBuffer()], { type: 'image/jpeg' }), 'IMG_0002.jpg');
  const sniffed = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: mislabelled });
  assert.equal(sniffed.status, 415, 'a HEIC labelled as JPEG is still refused');

  // Some clients label any upload as octet-stream. The signature check runs
  // before the type allow-list, so this still gets the HEIC instruction instead
  // of a generic "unsupported image type" that tells the user nothing.
  const octet = new FormData();
  octet.append('photo', new Blob([heicBuffer()], { type: 'application/octet-stream' }), 'IMG_0003.heic');
  const octetRes = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: octet });
  assert.equal(octetRes.status, 415, 'a HEIC sent as application/octet-stream is refused as HEIC');
  assert.match((await json(octetRes)).error || '', /HEIC/i, 'and still names HEIC, not the content type');

  // The converse, so the sniff can't swallow genuinely unsupported input: text
  // with no picture in it is refused, and says what was looked for.
  const notAnImage = new FormData();
  notAnImage.append('photo', new Blob([Buffer.from('just some text')], { type: 'text/plain' }), 'notes.txt');
  const plain = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: notAnImage });
  assert.equal(plain.status, 415, 'a file with no image is unsupported media, not a HEIC message and not a 500');
  assert.match((await json(plain)).error || '', /No image found/, 'and says plainly that no image was found');

  assert.equal(await draftCount(), before, 'a refused upload leaves no draft behind');
}

// A JPEG whose header claims 12000x12000 (144 megapixels): under sharp's own
// hard limit, over Thriftly's 40, and cheap because no such image is ever encoded.
function oversizedJpeg(jpeg) {
  const buffer = Buffer.from(jpeg);
  for (let i = 2; i + 9 < buffer.length; i++) {
    if (buffer[i] !== 0xff) continue;
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      buffer.writeUInt16BE(12000, i + 5);
      buffer.writeUInt16BE(12000, i + 7);
      return buffer;
    }
  }
  throw new Error('test image has no SOF marker');
}

// ---------- hostile input ----------
// The upload path takes arbitrary files, so each one is treated as hostile:
// programs renamed as images, archives claiming huge members, malformed
// containers, SVGs that pull in URLs, and images too big to decode safely.
async function maliciousUploadFlow(token) {
  const listDrafts = async () => json(await fetch(`${BASE}/api/drafts`, { headers: authHeaders(token) }));
  const before = await listDrafts();
  const upload = async (bytes, type, name) => {
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type }), name);
    const res = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { res, body: await json(res) };
  };

  const program = Buffer.alloc(512);
  program.write('MZ', 0, 'ascii');
  const exe = await upload(program, 'image/png', 'photo.png');
  assert.equal(exe.res.status, 415, 'a renamed program is refused');
  assert.match(exe.body.error || '', /program/i, 'and is named as one');

  const noise = await upload(Buffer.from('not a file at all, just bytes'), 'image/jpeg', 'x.jpg');
  assert.equal(noise.res.status, 415, 'random bytes are refused');

  // Truncated containers must fail closed, not 500.
  const badZip = await upload(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]), 'application/zip', 'broken.zip');
  assert.equal(badZip.res.status, 415, 'a truncated zip is refused, not a server error');
  const badPdf = await upload(Buffer.from('%PDF-1.4\n' + 'x'.repeat(100)), 'application/pdf', 'broken.pdf');
  assert.equal(badPdf.res.status, 415, 'a truncated PDF is refused too');

  // A member that claims to expand to 100 MB is skipped before any inflation.
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#003366' } }).png().toBuffer();
  const bomb = makeZip([{ name: 'word/media/image1.png', data: png, deflate: true, claim: 100 * 1024 * 1024 }]);
  const bombed = await upload(bomb, 'application/zip', 'bomb.zip');
  assert.equal(bombed.res.status, 415, 'a zip member claiming 100 MB is skipped');

  // Declared size is checked before rasterising.
  const bigSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200000" height="200000"><rect width="10" height="10"/></svg>');
  const huge = await upload(bigSvg, 'image/svg+xml', 'huge.svg');
  assert.equal(huge.res.status, 415, 'an SVG declaring a 200000px side is refused');
  assert.match(huge.body.error || '', /too large|40 megapixels/i, 'and says the size is the problem');

  // No outbound request on behalf of an uploaded file.
  const hits = { count: 0 };
  const leak = http.createServer((req, res) => { hits.count += 1; res.writeHead(200); res.end('x'); });
  await new Promise((resolve) => leak.listen(0, '127.0.0.1', resolve));
  try {
    const remoteSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="http://127.0.0.1:${leak.address().port}/leak.png" width="10" height="10"/></svg>`);
    const pulled = await upload(remoteSvg, 'image/svg+xml', 'remote.svg');
    assert.equal(pulled.res.status, 415, 'an SVG that references a URL is refused');
    assert.equal(hits.count, 0, 'and nothing was fetched from that URL');
  } finally {
    await new Promise((resolve) => leak.close(resolve));
  }


  // Pixel bombs are judged from the header alone, whether the image is the upload
  // itself or hiding inside a PDF.
  const pixelSource = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#884466' } }).jpeg().toBuffer();
  const hugeJpeg = oversizedJpeg(pixelSource);
  const hugeDirect = await upload(hugeJpeg, 'image/jpeg', 'huge.jpg');
  assert.equal(hugeDirect.res.status, 415, 'a 144-megapixel JPEG is refused');
  assert.match(hugeDirect.body.error || '', /too large|40 megapixels/i, 'and says the size is the problem');
  const hugePdf = await upload(
    Buffer.concat([Buffer.from('%PDF-1.4\nstream\n'), hugeJpeg, Buffer.from('\nendstream\n%%EOF\n')]),
    'application/pdf', 'huge.pdf',
  );
  assert.equal(hugePdf.res.status, 415, 'the same image inside a PDF is refused too');
  assert.match(hugePdf.body.error || '', /too large|40 megapixels/i, 'with the same size explanation');

  // The size limit is enforced before the body reaches the route.
  const oversized = await upload(Buffer.alloc(13 * 1024 * 1024), 'image/jpeg', 'big.jpg');
  assert.equal(oversized.res.status, 413, 'an oversized upload is refused with 413');
  assert.match(oversized.body.error || '', /12 MB/i, 'and names the limit');

  // Polyglot: JPEG bytes with markup appended. Re-encoding must strip it.
  const jpeg = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#448844' } }).jpeg().toBuffer();
  const polyglot = Buffer.concat([jpeg, Buffer.from('\n<script>alert(1)</script>')]);
  const scanned = await upload(polyglot, 'image/jpeg', 'poly.jpg');
  assert.equal(scanned.res.status, 201, 'a JPEG with rubbish appended still scans, because it is a JPEG');
  const served = await fetch(`${BASE}${scanned.body.thumb}`);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff', 'served photos are never sniffed');
  assert.match(served.headers.get('content-security-policy') || '', /sandbox/, 'and are sandboxed if opened directly');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.equal(bytes[0], 0xff, 'the served file is the re-encoded jpeg');
  assert.ok(!bytes.includes(Buffer.from('<script')), 'the appended markup did not survive storage');

  assert.equal((await listDrafts()).length, before.length + 1, 'only the genuine image created a draft');
  for (const draft of await listDrafts()) {
    if (before.some((old) => old.id === draft.id)) continue;
    await fetch(`${BASE}/api/drafts/${draft.id}`, { method: 'DELETE', headers: authHeaders(token) });
  }
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
  ttlGuardChecks(photosModule);
  console.log(`  ok   STORAGE_CHECK_TTL_MS guard falls back on malformed values (${Date.now() - step}ms)`);

  step = Date.now();
  await storageClientChecks(storage);
  console.log(`  ok   photos.js upload/read/delete/upsert/errors over HTTP (${Date.now() - step}ms)`);

  step = Date.now();
  child = startApp(storage, gemini);
  await waitForServer(child);
  const { token, jpeg } = await apiFlows(storage, gemini);
  console.log(`  ok   scan → upload → serve → export → draft delete (${Date.now() - step}ms)`);

  step = Date.now();
  await heicRejectionFlow(token);
  console.log(`  ok   HEIC refused with instructions, mislabelled ones sniffed too (${Date.now() - step}ms)`);

  step = Date.now();
  await containerImageFlow(storage, token);
  console.log(`  ok   photo hidden in a PDF, docx zip and SVG is found and scanned (${Date.now() - step}ms)`);

  step = Date.now();
  await maliciousUploadFlow(token);
  console.log(`  ok   hostile uploads refused: program, zip bomb, bad containers, remote SVG, 13MB, polyglot (${Date.now() - step}ms)`);

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
