import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PublicError } from './errors.js';
import { describeUpload } from './inspect.js';

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const verified = new Map();

export function isDocumentId(id) {
  return ID_RE.test(id);
}

function resolveInside(root, name) {
  const base = path.resolve(root);
  const full = path.resolve(base, name);
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PublicError(404, 'This document is not here.');
  }
  return full;
}

export function storedFilePath(storageDir, id) {
  if (!isDocumentId(id)) throw new PublicError(404, 'This document is not here.');
  return resolveInside(path.join(storageDir, 'files'), id);
}

function metaFilePath(storageDir, id) {
  if (!isDocumentId(id)) throw new PublicError(404, 'This document is not here.');
  return resolveInside(path.join(storageDir, 'meta'), `${id}.json`);
}

export function initStore(storageDir) {
  fs.mkdirSync(path.join(storageDir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'meta'), { recursive: true });
}

export function cleanTemp(storageDir) {
  const dir = path.join(storageDir, 'tmp');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      // A leftover temp file can wait for the next cleanup.
    }
  }
}

function assertInsideTemp(storageDir, tempPath) {
  const root = path.resolve(storageDir, 'tmp');
  const full = path.resolve(tempPath);
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PublicError(400, 'The upload could not be read.');
  }
  return full;
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function allocateId(storageDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = crypto.randomBytes(12).toString('base64url');
    if (!isDocumentId(id)) continue;
    if (await exists(storedFilePath(storageDir, id))) continue;
    if (await exists(metaFilePath(storageDir, id))) continue;
    return id;
  }
  throw new PublicError(500, 'Could not prepare a document id. Try again.');
}

async function writeExclusive(tempPath, dest) {
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(
      fs.createReadStream(tempPath),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(dest, { flags: 'wx', mode: 0o666 }),
    );
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.promises.unlink(dest).catch(() => {});
    if (error.code === 'EEXIST') {
      throw new PublicError(500, 'Could not store the document. Try again.');
    }
    throw error;
  }
  const handle = await fs.promises.open(dest, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function isSafePreviewUrl(url, id) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && (parsed.pathname === `/d/${id}` || parsed.pathname === `/d/${id}/file`);
}

function isMeta(value, id) {
  return Boolean(value)
    && value.id === id
    && value.sealed === true
    && typeof value.originalName === 'string'
    && value.originalName.length > 0
    && value.originalName.length <= 180
    && !/[\u0000-\u001f\u007f]/.test(value.originalName)
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isInteger(value.size)
    && value.size > 0
    && typeof value.createdAt === 'string'
    && typeof value.mime === 'string'
    && /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=utf-8)?$/.test(value.mime)
    && ['image', 'pdf', 'text', 'none'].includes(value.preview)
    && isSafePreviewUrl(value.previewUrl, id);
}

export async function readMeta(storageDir, id) {
  if (!isDocumentId(id)) return null;
  let raw;
  try {
    raw = await fs.promises.readFile(metaFilePath(storageDir, id), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicError(500, 'The seal record cannot be read.');
  }
  if (!isMeta(parsed, id)) throw new PublicError(500, 'The seal record cannot be read.');
  return parsed;
}

// A published document is written once. This module never updates or deletes it.
export async function sealDocument(storageDir, { tempPath, originalName, origin }) {
  const source = assertInsideTemp(storageDir, tempPath);
  const stat = await fs.promises.stat(source);
  if (!stat.isFile() || stat.size === 0) {
    throw new PublicError(400, 'The file is empty.');
  }
  const described = await describeUpload(source, originalName, stat.size);
  const id = await allocateId(storageDir);
  const dest = storedFilePath(storageDir, id);
  const sha256 = await writeExclusive(source, dest);
  await fs.promises.chmod(dest, 0o444).catch(() => {});
  const meta = {
    id,
    originalName,
    mime: described.mime,
    preview: described.preview,
    size: stat.size,
    sha256,
    previewUrl: `${origin}/d/${id}/file`,
    createdAt: new Date().toISOString(),
    sealed: true,
  };
  const record = metaFilePath(storageDir, id);
  try {
    await fs.promises.writeFile(record, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  } catch (error) {
    await fs.promises.unlink(dest).catch(() => {});
    if (error.code === 'EEXIST') {
      throw new PublicError(500, 'Could not store the document. Try again.');
    }
    throw error;
  }
  await fs.promises.chmod(record, 0o444).catch(() => {});
  return meta;
}

export async function assertIntact(storageDir, meta) {
  const abs = storedFilePath(storageDir, meta.id);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new PublicError(500, 'The sealed file is missing from storage.');
    }
    throw error;
  }
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = verified.get(meta.id);
  if (cached && cached.key === cacheKey && cached.sha256 === meta.sha256) return abs;
  if (stat.size !== meta.size) {
    throw new PublicError(409, 'This sealed file was altered on disk and will not be shown.');
  }
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(abs), hash);
  const digest = hash.digest('hex');
  if (digest !== meta.sha256) {
    throw new PublicError(409, 'This sealed file was altered on disk and will not be shown.');
  }
  if (verified.size > 500) verified.clear();
  verified.set(meta.id, { key: cacheKey, sha256: digest });
  return abs;
}
