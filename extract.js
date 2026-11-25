'use strict';
// ---------- find the photo inside whatever was uploaded ----------
// People don't only have photos. A listing often starts as a PDF receipt, a Word
// doc with a product shot, or a folder zipped up. Instead of making them extract
// the picture first, look inside the container and hand the biggest usable image to
// the normal scan pipeline. The original file is never stored — only the image
// that comes out of it.
//
// No archive library: PDFs are read by their JPEG stream markers, zip-based formats
// (docx/xlsx/pptx/odt/epub/zip) by their central directory with zlib for deflate.
// Both paths validate every candidate with sharp before accepting it, so a
// malformed or hostile container fails closed rather than reaching the model.
//
// Formats are not listed here. Anything that isn't a container, a program, a HEIC
// or an SVG is handed to sharp, so the accepted set can't drift out of step with
// the library that actually decodes it — and a new raster format works for free.
const zlib = require('zlib');
const sharp = require('sharp');
const { MAX_PIXELS } = require('./photos');

const MAX_ZIP_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 25 * 1024 * 1024;
// Ceilings that make the decompression side safe by construction: one zip may not
// spend more than 48 MB of inflation across the whole upload, and no image may be
// larger than MAX_PIXELS, so a header claiming 50000x50000 can't turn a few KB into
// gigabytes of pixels.
const MAX_INFLATED_TOTAL = 48 * 1024 * 1024;
const MAX_CANDIDATES = 8;
const MAX_SVG_SIDE = 8000;
const MAX_TAG_BYTES = 8192;
const SVG_TAG = Buffer.from('<svg');
const HEIC_TAG = Buffer.from('ftyp');

// HEIC is what iPhones shoot by default and this sharp build has libheif for AVIF
// only — HEVC decoding is absent — so it has to be named before sharp sees it.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

// Only the cases that need a decision before a decoder gets a say. Everything else
// is 'other' and gets one attempt at being an image.
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return 'other';
  // Programs first: a renamed .exe never becomes a photo, whatever the client
  // claims in the extension or Content-Type, and saying so beats "no image found".
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'executable'; // MZ / PE
  if (buffer[0] === 0x7f && buffer.toString('ascii', 1, 4) === 'ELF') return 'executable';
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(buffer.readUInt32BE(0))) return 'executable';
  if (buffer[0] === 0x23 && buffer[1] === 0x21) return 'executable'; // #! script
  if (buffer.subarray(4, 8).equals(HEIC_TAG) && HEIF_BRANDS.has(buffer.toString('ascii', 8, 12).toLowerCase())) return 'heic';
  if (buffer.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return 'ole';
  // The whole file, not a window: any amount of comments can precede the tag, and
  // an enormous declared size makes metadata() throw before it can report a
  // format. A byte search costs nothing next to rasterising.
  if (buffer.includes(SVG_TAG)) return 'svg';
  return 'other';
}

// Largest usable image from a list of candidates. Header dimensions are read with
// a pixel ceiling in force, so an image claiming enormous dimensions is judged
// before anything decodes it.
async function largestImage(buffers) {
  let best = null;
  let tooLarge = false;
  for (const buffer of buffers) {
    try {
      // No limitInputPixels here: it makes metadata() throw instead of reporting
      // dimensions, which would turn "too large" into "couldn't read". Metadata
      // parses headers only, so reading the claim is free; decoding is guarded
      // separately by shrink().
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) continue;
      const area = meta.width * meta.height;
      if (area > MAX_PIXELS) { tooLarge = true; continue; }
      if (!best || area > best.area) best = { buffer, area };
    } catch { /* not an image sharp can read: try the next candidate */ }
  }
  return { buffer: best ? best.buffer : null, tooLarge: !best && tooLarge };
}

// ---------- PDF ----------
// Photos in PDFs are almost always DCTDecode streams, i.e. a JPEG sitting in the
// file. Entropy-coded data byte-stuffs every 0xFF, so an FF D9 pair can only be
// the end-of-image marker — no full PDF parser required.
const PDF_JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_JPEG_END = Buffer.from([0xff, 0xd9]);

function pdfImages(buffer) {
  const found = [];
  let at = buffer.indexOf(PDF_JPEG_START);
  while (at !== -1 && found.length < 500) {
    const end = buffer.indexOf(PDF_JPEG_END, at + 3);
    if (end === -1) break;
    found.push(buffer.subarray(at, end + 2));
    at = buffer.indexOf(PDF_JPEG_START, end + 2);
  }
  return largestImage(found.sort((a, b) => b.length - a.length).slice(0, MAX_CANDIDATES));
}

// ---------- zip containers ----------
function readCentralDirectory(buffer) {
  const EOCD = 0x06054b50;
  const MIN_EOCD = 22;
  const stop = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - MIN_EOCD; i >= stop; i--) {
    if (buffer.readUInt32LE(i) !== EOCD) continue;
    return {
      count: buffer.readUInt16LE(i + 10),
      size: buffer.readUInt32LE(i + 12),
      offset: buffer.readUInt32LE(i + 16),
    };
  }
  return null;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|avif)$/i;

function zipImageEntries(buffer) {
  const dir = readCentralDirectory(buffer);
  if (!dir) return [];
  const entries = [];
  const end = Math.min(buffer.length, dir.offset + dir.size);
  let at = dir.offset;
  for (let i = 0; i < dir.count && i < MAX_ZIP_ENTRIES && at + 46 <= end; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (!IMAGE_EXT_RE.test(name) || name.startsWith('__MACOSX/') || name.endsWith('/')) continue;
    // We never write members to disk, but an absolute or ../ path is a sign of a
    // crafted archive rather than a document, so it gets no further attention.
    if (name.startsWith('/') || name.includes('../') || /^[A-Za-z]:/.test(name)) continue;
    // A zip bomb is just a big number in the header: refuse anything that claims
    // to expand beyond the cap before touching it.
    if (size > MAX_UNCOMPRESSED || compressedSize > MAX_UNCOMPRESSED) continue;
    entries.push({ method, compressedSize, size, localOffset });
  }
  return entries.sort((a, b) => b.size - a.size).slice(0, MAX_CANDIDATES);
}

function zipEntryData(buffer, entry, budget) {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) return null;
  if (entry.method === 0) return raw;
  if (entry.method !== 8) return null; // bzip2/lzma members aren't worth supporting here
  // Inflate is bounded twice: by the per-member cap and by what is left of the
  // upload's total budget, so eight large members can't add up to an outage.
  const allowed = Math.min(MAX_UNCOMPRESSED, budget.remaining);
  if (allowed <= 0) return null;
  try {
    const inflated = zlib.inflateRawSync(raw, { maxOutputLength: allowed });
    budget.remaining -= inflated.length;
    return inflated;
  } catch {
    // Over the cap or corrupt: stop spending budget on this archive.
    budget.remaining = 0;
    return null;
  }
}

async function zipImages(buffer) {
  const budget = { remaining: MAX_INFLATED_TOTAL };
  const candidates = zipImageEntries(buffer)
    .map((entry) => zipEntryData(buffer, entry, budget))
    .filter(Boolean);
  return largestImage(candidates);
}

// ---------- SVG ----------
// An SVG is closer to a small program than a picture: it can reference other files,
// carry scripts and declare any size it likes. Thriftly only needs flat stickers, so
// every reference must stay inside the document (`#thing`) — a rasteriser then has
// nothing external it could fetch on an upload's behalf.
const SVG_REFERENCE_RE = /(?:xlink:href|href|src)\s*=\s*["']([^"']*)["']/gi;
const SVG_CSS_URL_RE = /url\(\s*["']?([^"')]*)["']?\s*\)/gi;

// End of the opening <svg ...> tag, respecting quoted attribute values (a path or
// a style can contain '>'). Refuses an absurdly long tag rather than scanning on.
function svgTagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length && i - start <= MAX_TAG_BYTES; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

// Reads the whole file: a comment can be any length, so checking only the first
// few KB would let a padded SVG past the reference, script and size rules.
function svgProblem(buffer) {
  const text = buffer.toString('utf8');
  if (/<script|<!entity/i.test(text)) return 'unsafe-svg';
  for (const pattern of [SVG_REFERENCE_RE, SVG_CSS_URL_RE]) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1].trim();
      if (target && !target.startsWith('#')) return 'unsafe-svg';
    }
  }
  const start = text.search(/<svg\b/i);
  if (start === -1) return 'unreadable';
  const end = svgTagEnd(text, start);
  if (end === -1) return 'unreadable';
  const tag = text.slice(start, end);
  const attr = (name) => {
    const found = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return found ? parseFloat(found[1]) : NaN;
  };
  const width = attr('width');
  const height = attr('height');
  if (width > MAX_SVG_SIDE || height > MAX_SVG_SIDE) return 'too-large';
  if (width > 0 && height > 0 && width * height > MAX_PIXELS) return 'too-large';
  const box = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (box) {
    const parts = box[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] * parts[3] > MAX_PIXELS) return 'too-large';
  }
  return null;
}

function rasterizeSvg(buffer) {
  // Here the limit matters: rasterising allocates the pixels. Declared dimensions
  // were already checked, so this only guards a document that hid its size.
  return sharp(buffer, { density: 96, limitInputPixels: MAX_PIXELS }).png().toBuffer();
}

// Every SVG path ends here — whether the sniff spotted it or sharp did — so the
// guards cannot be skipped by which branch recognised the file.
async function extractSvg(buffer) {
  const problem = svgProblem(buffer);
  if (problem) return { ok: false, reason: problem, kind: 'svg' };
  try {
    return { ok: true, buffer: await rasterizeSvg(buffer), kind: 'svg' };
  } catch {
    return { ok: false, reason: 'unreadable', kind: 'svg' };
  }
}

// ---------- public entry point ----------
// ok:true  -> { buffer } is a raster image the rest of the pipeline understands
// ok:false -> reason names why, so the route can say something useful
async function extractOne(buffer) {
  const kind = sniff(buffer);
  const fail = (reason) => ({ ok: false, reason, kind });

  if (kind === 'heic') return fail('heic');
  if (kind === 'executable') return fail('executable');
  if (kind === 'ole') return fail('legacy');

  if (kind === 'svg') return extractSvg(buffer);

  if (kind === 'pdf' || kind === 'zip') {
    const found = kind === 'pdf' ? await pdfImages(buffer) : await zipImages(buffer);
    if (found.buffer) return { ok: true, buffer: found.buffer, kind };
    return fail(found.tooLarge ? 'too-large' : 'no-image');
  }

  // 'other': let sharp decide what the file is. Its format report is authoritative
  // — a padded SVG that the sniff couldn't see is still an SVG and must take the
  // guarded path, not the generic image one.
  try {
    const meta = await sharp(buffer).metadata();
    if (meta.format === 'svg') return extractSvg(buffer);
    if (!meta.width || !meta.height) return fail('no-image');
    if (meta.width * meta.height > MAX_PIXELS) return fail('too-large');
    return { ok: true, buffer, kind: 'image' };
  } catch {
    return fail('no-image');
  }
}

// Nothing a hostile file does should reach the error middleware as a 500: a
// truncated archive or an offset past the end of the buffer is reported as
// "couldn't read that" instead of surfacing as a server error.
async function extractImage(buffer) {
  try {
    return await extractOne(buffer);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

module.exports = { extractImage };
