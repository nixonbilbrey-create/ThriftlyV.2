'use strict';
// ---------- find the photo inside whatever was uploaded ----------
// People don't only have photos. A listing often starts as a PDF receipt, a Word
// doc with a product shot, or a folder zipped up. Instead of making them extract
// the picture first, look inside the container and hand the biggest decodable
// image to the normal scan pipeline. The original file is never stored — only the
// image that comes out of it.
//
// No archive library: PDFs are read by their JPEG stream markers, and zip-based
// formats (docx/xlsx/pptx/odt/epub/zip) by their central directory with zlib for
// deflate. Both paths validate every candidate with sharp before accepting it, so
// a malformed or hostile container fails closed rather than feeding garbage to the
// model.
const zlib = require('zlib');
const sharp = require('sharp');

const MAX_ZIP_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 25 * 1024 * 1024;
const MAX_CANDIDATES = 8;
// Ceilings that make the decompression side safe by construction:
// - a zip may not spend more than 48 MB of inflation across the whole upload
// - no single image (inside a file or not) may be larger than 40 megapixels, so a
//   header claiming 50000×50000 can't turn a few KB into gigabytes of pixels
// - SVG is rasterised at 96 DPI and refused if it declares more than 8000 px a side
const MAX_INFLATED_TOTAL = 48 * 1024 * 1024;
const MAX_PIXELS = 40 * 1000 * 1000;
const MAX_SVG_SIDE = 8000;
const MAX_SVG_BYTES = 16384;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|avif)$/i;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const DIRECT_IMAGE = new Set(['jpeg', 'png', 'gif', 'webp', 'avif', 'tiff', 'bmp']);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buffer) {
  if (!buffer || buffer.length < 12) return 'unknown';
  // Programs first: a renamed .exe is not going to become a photo no matter what
  // extension or Content-Type the client claims, and saying so is clearer than
  // "no image found".
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'executable'; // MZ / PE
  if (buffer[0] === 0x7f && buffer.toString('ascii', 1, 4) === 'ELF') return 'executable';
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(buffer.readUInt32BE(0))) return 'executable';
  if (buffer[0] === 0x23 && buffer[1] === 0x21) return 'executable'; // #! script
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (HEIF_BRANDS.has(brand)) return 'heic';
  }
  if (buffer.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[3] === 0x2a)) return 'tiff';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  // Older Office formats are OLE containers; their images need a parser this
  // build doesn't have, so they get a specific "save as .docx" answer.
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return 'ole';
  const head = buffer.subarray(0, 1024).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return 'unknown';
}

// Largest usable image from a list of candidates. Header dimensions are read with
// a pixel ceiling in force, so an image that claims enormous dimensions is judged
// before anything decodes it.
async function pickLargest(buffers) {
  let best = null;
  let sawTooLarge = false;
  for (const buffer of buffers) {
    try {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta.width || !meta.height) continue;
      const area = meta.width * meta.height;
      if (area > MAX_PIXELS) { sawTooLarge = true; continue; }
      if (!best || area > best.area) best = { buffer, area };
    } catch { /* not an image we can read; try the next candidate */ }
  }
  if (best) return { buffer: best.buffer };
  return sawTooLarge ? { tooLarge: true } : null;
}

// ---------- PDF ----------
// Photos in PDFs are almost always DCTDecode streams, i.e. a JPEG sitting in the
// file. Entropy-coded data byte-stuffs every 0xFF, so an FF D9 pair can only be
// the end-of-image marker — no full PDF parser required.
function pdfJpegStreams(buffer) {
  const soi = Buffer.from([0xff, 0xd8, 0xff]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const found = [];
  let at = buffer.indexOf(soi);
  while (at !== -1 && found.length < 500) {
    const end = buffer.indexOf(eoi, at + 3);
    if (end === -1) break;
    found.push(buffer.subarray(at, end + 2));
    at = buffer.indexOf(soi, end + 2);
  }
  return found.sort((a, b) => b.length - a.length).slice(0, MAX_CANDIDATES);
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
  if (entry.method === 8) {
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
  return null; // bzip2/lzma members aren't worth supporting here
}

async function fromZip(buffer) {
  const budget = { remaining: MAX_INFLATED_TOTAL };
  const candidates = zipImageEntries(buffer)
    .map((entry) => zipEntryData(buffer, entry, budget))
    .filter(Boolean);
  return pickLargest(candidates);
}

async function fromPdf(buffer) {
  return pickLargest(pdfJpegStreams(buffer));
}

// ---------- SVG rules ----------
// An SVG is closer to a small program than a picture: it can reference other
// files, carry scripts and declare any size it likes. Thriftly only needs flat
// stickers, so anything that pulls resources in is refused rather than hoping the
// rasteriser ignores it — which also means no outbound request to a URL an
// uploaded file chooses.
function svgProblem(buffer) {
  const text = buffer.subarray(0, MAX_SVG_BYTES).toString('utf8');
  if (/<script|javascript:|<!entity/i.test(text)) return 'unsafe-svg';
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|file:)/i.test(text)) return 'unsafe-svg';
  if (/<image\b|@import|url\(\s*["']?(?:https?:|\/\/|file:)/i.test(text)) return 'unsafe-svg';
  const tag = text.match(/<svg\b[^>]*>/i);
  if (tag) {
    const attr = (name) => {
      const found = tag[0].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
      return found ? parseFloat(found[1]) : NaN;
    };
    const width = attr('width');
    const height = attr('height');
    if (width > MAX_SVG_SIDE || height > MAX_SVG_SIDE) return 'too-large';
    const box = tag[0].match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
    if (box) {
      const parts = box[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] * parts[3] > MAX_PIXELS) return 'too-large';
    }
    if (width > 0 && height > 0 && width * height > MAX_PIXELS) return 'too-large';
  }
  return null;
}

// ---------- public entry point ----------
// ok:true  -> { buffer } is a raster image the rest of the pipeline understands
// ok:false -> reason names why, so the route can say something useful
async function extractOne(buffer) {
  const kind = sniff(buffer);

  if (kind === 'heic') return { ok: false, reason: 'heic', kind };
  if (kind === 'executable') return { ok: false, reason: 'executable', kind };
  if (DIRECT_IMAGE.has(kind)) {
    try {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta.width || !meta.height) return { ok: false, reason: 'unreadable', kind };
      if (meta.width * meta.height > MAX_PIXELS) return { ok: false, reason: 'too-large', kind };
      return { ok: true, buffer, kind };
    } catch {
      return { ok: false, reason: 'unreadable', kind };
    }
  }
  if (kind === 'svg') {
    const problem = svgProblem(buffer);
    if (problem) return { ok: false, reason: problem, kind };
    try {
      const png = await sharp(buffer, { density: 96, limitInputPixels: MAX_PIXELS }).png().toBuffer();
      const meta = await sharp(png).metadata();
      if (!meta.width || !meta.height) return { ok: false, reason: 'unreadable', kind };
      if (meta.width * meta.height > MAX_PIXELS) return { ok: false, reason: 'too-large', kind };
      return { ok: true, buffer: png, kind };
    } catch {
      return { ok: false, reason: 'unreadable', kind };
    }
  }
  if (kind === 'pdf' || kind === 'zip') {
    const image = kind === 'pdf' ? await fromPdf(buffer) : await fromZip(buffer);
    if (image && image.buffer) return { ok: true, buffer: image.buffer, kind };
    return { ok: false, reason: image && image.tooLarge ? 'too-large' : 'no-image', kind };
  }
  if (kind === 'ole') return { ok: false, reason: 'legacy', kind };
  return { ok: false, reason: 'no-image', kind };
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

module.exports = { extractImage, sniff };
