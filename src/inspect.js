import fs from 'node:fs';
import { PublicError } from './errors.js';

const DANGEROUS = new Set([
  'exe', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'msp', 'dll', 'sys',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'jar',
  'apk', 'html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'cer',
  'cgi', 'sh', 'bash', 'reg', 'lnk', 'msc', 'hta', 'cpl', 'inf', 'wsf',
  'wsh', 'iso',
]);

const CLAIM = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  avif: 'avif',
};

const IMAGE_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const EXT_MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
};

const TEXT_EXT = new Set(['txt', 'csv', 'md', 'log']);
const TEXT_PREVIEW_LIMIT = 200_000;

function recoverUtf8Name(raw) {
  const name = String(raw ?? '');
  if ([...name].some((char) => char.charCodeAt(0) > 255)) return name;
  const recovered = Buffer.from(name, 'latin1').toString('utf8');
  if (recovered.includes('\uFFFD')) return name;
  return recovered;
}

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function normalizeOriginalName(raw) {
  let name = recoverUtf8Name(raw).replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/\\/g, '/').split('/').pop() || '';
  name = name.trim().replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') {
    throw new PublicError(400, 'Choose a file that has a name.');
  }
  if (name.length > 180) {
    throw new PublicError(400, 'That file name is too long. Use 180 characters or fewer.');
  }
  return name;
}

export function isDangerousName(name) {
  const ext = extensionOf(name);
  return ext !== '' && DANGEROUS.has(ext);
}

export function sniff(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 6) {
    const gif = buffer.subarray(0, 6).toString('latin1');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

async function sniffFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return sniff(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function isPlainText(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export async function describeUpload(filePath, originalName, size) {
  const ext = extensionOf(originalName);
  const kind = await sniffFile(filePath);
  if (CLAIM[ext] && kind !== CLAIM[ext]) {
    throw new PublicError(400, 'The file contents do not match its name.');
  }
  if (kind === 'pdf') return { preview: 'pdf', mime: 'application/pdf' };
  if (kind && IMAGE_MIME[kind]) return { preview: 'image', mime: IMAGE_MIME[kind] };
  if (TEXT_EXT.has(ext) && size <= TEXT_PREVIEW_LIMIT && await isPlainText(filePath)) {
    const mime = ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
    return { preview: 'text', mime };
  }
  return { preview: 'none', mime: EXT_MIME[ext] || 'application/octet-stream' };
}

export function qrDownloadName(originalName) {
  const ext = extensionOf(originalName);
  const stem = ext ? originalName.slice(0, -(ext.length + 1)) : originalName;
  const base = stem.trim() || 'document';
  return `${base} QR.png`;
}
