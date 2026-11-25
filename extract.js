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
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|avif)$/i;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const DIRECT_IMAGE = new Set(['jpeg', 'png', 'gif', 'webp', 'avif', 'tiff', 'bmp']);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buffer) {
  if (!buffer || buffer.length < 12) return 'unknown';
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

// Largest decodable image from a list of candidates. Metadata alone decides the
// winner; the bytes are decoded later by the normal resize pass.
async function pickLargest(buffers) {
  let best = null;
  for (const buffer of buffers) {
    try {
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) continue;
      const area = meta.width * meta.height;
      if (!best || area > best.area) best = { buffer, area };
    } catch { /* not an image we can read; try the next candidate */ }
  }
  return best ? best.buffer : null;
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
    // A zip bomb is just a big number in the header: refuse anything that claims
    // to expand beyond the cap before touching it.
    if (size > MAX_UNCOMPRESSED || compressedSize > MAX_UNCOMPRESSED) continue;
    entries.push({ method, compressedSize, size, localOffset });
  }
  return entries.sort((a, b) => b.size - a.size).slice(0, MAX_CANDIDATES);
}

function zipEntryData(buffer, entry) {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) return null;
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED });
    } catch { return null; }
  }
  return null; // bzip2/lzma members aren't worth supporting here
}

async function fromZip(buffer) {
  const candidates = zipImageEntries(buffer)
    .map((entry) => zipEntryData(buffer, entry))
    .filter(Boolean);
  return pickLargest(candidates);
}

async function fromPdf(buffer) {
  return pickLargest(pdfJpegStreams(buffer));
}

// ---------- public entry point ----------
// ok:true  -> { buffer } is a raster image the rest of the pipeline understands
// ok:false -> reason names why, so the route can say something useful
async function extractImage(buffer) {
  const kind = sniff(buffer);

  if (kind === 'heic') return { ok: false, reason: 'heic', kind };
  if (DIRECT_IMAGE.has(kind)) {
    try {
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) return { ok: false, reason: 'unreadable', kind };
      return { ok: true, buffer, kind };
    } catch {
      return { ok: false, reason: 'unreadable', kind };
    }
  }
  if (kind === 'svg') {
    try {
      return { ok: true, buffer: await sharp(buffer, { density: 150 }).png().toBuffer(), kind };
    } catch {
      return { ok: false, reason: 'unreadable', kind };
    }
  }
  if (kind === 'pdf') {
    const image = await fromPdf(buffer);
    return image ? { ok: true, buffer: image, kind } : { ok: false, reason: 'no-image', kind };
  }
  if (kind === 'zip') {
    const image = await fromZip(buffer);
    return image ? { ok: true, buffer: image, kind } : { ok: false, reason: 'no-image', kind };
  }
  if (kind === 'ole') return { ok: false, reason: 'legacy', kind };
  return { ok: false, reason: 'no-image', kind };
}

module.exports = { extractImage, sniff };
