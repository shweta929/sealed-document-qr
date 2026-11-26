import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { PublicError } from './errors.js';
import { formatBytes, formatLimit, formatWhen } from './format.js';
import { isDangerousName, normalizeOriginalName, qrDownloadName } from './inspect.js';
import { documentAddress, isAllowedHost, lanIPv4, normalizePublicOrigin, parseHost, reachableOrigin } from './network.js';
import { errorPage, homePage, previewPage, readyPage, sendHtml } from './pages.js';
import { qrPng } from './qr.js';
import { contentDisposition, pipeFile } from './filesend.js';
import {
  assertIntact,
  cleanTemp,
  initStore,
  isDocumentId,
  readMeta,
  sealDocument,
} from './store.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const defaultStorage = path.join(rootDir, 'storage');
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

function present(meta) {
  return {
    id: meta.id,
    originalName: meta.originalName,
    size: meta.size,
    sizeLabel: formatBytes(meta.size),
    sha256: meta.sha256,
    preview: meta.preview,
    previewUrl: meta.previewUrl,
    createdAt: meta.createdAt,
    createdLabel: formatWhen(meta.createdAt),
    qrUrl: `/d/${meta.id}/qr.png`,
  };
}

function notFoundPage() {
  return errorPage({
    title: 'This document is not here',
    message: 'The link does not match a sealed document. Check the QR code and try again.',
  });
}

function warningUrlsFor(req) {
  const name = parseHost(req.get('host') || '');
  if (!['localhost', '127.0.0.1', '::1'].includes(name || '')) return null;
  const port = req.socket?.localPort;
  if (!port) return [];
  return lanIPv4().map((ip) => `http://${ip}:${port}`);
}

function uploadLimiter(max) {
  const hits = new Map();
  const windowMs = 10 * 60 * 1000;
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= max) {
      next(new PublicError(429, 'Too many uploads. Wait a few minutes and try again.'));
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

function makeUpload(storageDir, maxBytes) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        callback(null, path.join(storageDir, 'tmp'));
      },
      filename: (_req, _file, callback) => {
        callback(null, crypto.randomBytes(16).toString('hex'));
      },
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, callback) => {
      try {
        const name = normalizeOriginalName(file.originalname);
        if (isDangerousName(name)) {
          callback(new PublicError(400, 'This file type cannot be sealed. Executables and web pages are refused.'));
          return;
        }
        callback(null, true);
      } catch (error) {
        callback(error);
      }
    },
  });
}

export function createApp(options = {}) {
  const storageDir = options.storageDir || defaultStorage;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const shareLocal = options.shareLocal !== false;
  const publicUrlPath = path.join(storageDir, 'public-url.txt');

  function livePublicOrigin() {
    const fromEnv = normalizePublicOrigin(process.env.PUBLIC_URL || '');
    if (fromEnv) return fromEnv;
    try {
      return normalizePublicOrigin(fs.readFileSync(publicUrlPath, 'utf8'));
    } catch {
      return null;
    }
  }
  initStore(storageDir);
  cleanTemp(storageDir);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        frameSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'sameorigin' },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(express.static(publicDir, { index: false, dotfiles: 'deny', maxAge: '1h' }));

  const upload = makeUpload(storageDir, maxBytes);
  const limit = options.rateLimit === false ? (_req, _res, next) => next() : uploadLimiter(options.uploadsPerWindow ?? 30);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (req, res) => {
    sendHtml(res, 200, homePage({ maxBytes, warningUrls: warningUrlsFor(req), publicUrl: livePublicOrigin() }));
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/d/')) {
      next();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      next();
      return;
    }
    res.set('Allow', 'GET, HEAD');
    const message = 'This document is sealed and cannot be changed.';
    if (wantsJson(req)) {
      res.status(405).json({ error: message });
      return;
    }
    sendHtml(res, 405, errorPage({ title: 'Sealed', message }));
  });

  async function loadMeta(req, res) {
    if (!isDocumentId(req.params.id)) {
      sendHtml(res, 404, notFoundPage());
      return null;
    }
    const meta = await readMeta(storageDir, req.params.id);
    if (!meta) {
      sendHtml(res, 404, notFoundPage());
      return null;
    }
    return meta;
  }

  async function sendSealed(req, res, next, inline) {
    try {
      const meta = await loadMeta(req, res);
      if (!meta) return;
      const canShow = meta.preview === 'image' || meta.preview === 'pdf' || meta.preview === 'text';
      const abs = await assertIntact(storageDir, meta);
      pipeFile(req, res, abs, {
        mime: meta.mime,
        filename: meta.originalName,
        inline: inline && canShow,
        size: meta.size,
      });
    } catch (error) {
      next(error);
    }
  }

  app.post('/api/documents', limit, upload.single('document'), async (req, res, next) => {
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) throw new PublicError(400, 'Choose a file to seal.');
      const originalName = normalizeOriginalName(req.file.originalname);
      const host = req.get('host');
      const publicBase = livePublicOrigin();
      const publicHost = publicBase ? new URL(publicBase).hostname : null;
      if (!isAllowedHost(host, [req.socket?.localAddress, publicHost])) {
        throw new PublicError(400, 'Open this site from its real address, then create the QR code.');
      }
      const origin = reachableOrigin(req.protocol, host, shareLocal, publicBase);
      if (!origin) throw new PublicError(400, 'Open this site from its real address, then create the QR code.');
      const meta = await sealDocument(storageDir, {
        tempPath,
        originalName,
        origin,
      });
      console.log(JSON.stringify({ level: 'info', msg: 'document sealed', id: meta.id, size: meta.size }));
      if (wantsJson(req)) {
        res.status(201).json(present(meta));
        return;
      }
      res.redirect(303, `/d/${meta.id}/ready`);
    } catch (error) {
      next(error);
    } finally {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
    }
  });

  app.get('/d/:id/ready', async (req, res, next) => {
    try {
      const meta = await loadMeta(req, res);
      if (!meta) return;
      sendHtml(res, 200, readyPage(meta, documentAddress(meta.previewUrl, { shareLocal, publicBase: livePublicOrigin() })));
    } catch (error) {
      next(error);
    }
  });

  app.get('/d/:id/file', (req, res, next) => sendSealed(req, res, next, true));
  app.get('/d/:id/download', (req, res, next) => sendSealed(req, res, next, false));

  app.get('/d/:id/qr.png', async (req, res, next) => {
    try {
      const meta = await loadMeta(req, res);
      if (!meta) return;
      const png = await qrPng(documentAddress(meta.previewUrl, { shareLocal, publicBase: livePublicOrigin() }));
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.query.download === '1') {
        res.set('Content-Disposition', contentDisposition('attachment', qrDownloadName(meta.originalName)));
      }
      res.type('png').send(png);
    } catch (error) {
      next(error);
    }
  });

  app.get('/d/:id', async (req, res, next) => {
    try {
      const meta = await loadMeta(req, res);
      if (!meta) return;
      const abs = await assertIntact(storageDir, meta);
      let view = meta;
      if (meta.preview === 'text') {
        const buffer = await fs.promises.readFile(abs);
        try {
          view = { ...meta, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
        } catch {
          view = { ...meta, preview: 'none' };
        }
      }
      sendHtml(res, 200, previewPage(view));
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    sendHtml(res, 404, notFoundPage());
  });

  app.use((error, req, res, next) => {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    if (res.headersSent) {
      next(error);
      return;
    }
    const badUpload = /Multipart|Unexpected end of form|Boundary/i.test(error?.message || '');
    const status = error instanceof PublicError ? error.status
      : error?.code === 'LIMIT_FILE_SIZE' ? 413
        : error?.code === 'LIMIT_UNEXPECTED_FILE' || badUpload ? 400
          : 500;
    const opening = req.method === 'GET' && req.path.startsWith('/d/');
    let message;
    if (error instanceof PublicError) message = error.message;
    else if (error?.code === 'LIMIT_FILE_SIZE') message = `That file is larger than ${formatLimit(maxBytes)}.`;
    else if (error?.code === 'LIMIT_UNEXPECTED_FILE' || badUpload) message = 'Choose one file to seal.';
    else {
      console.error(JSON.stringify({ level: 'error', msg: 'request failed', detail: error?.message }));
      message = opening ? 'This document could not be opened.' : 'The document could not be sealed.';
    }
    if (wantsJson(req) || req.path.startsWith('/api/')) {
      res.status(status).json({ error: message });
      return;
    }
    const title = status === 413 ? 'File too large'
      : status === 405 ? 'Sealed'
        : status === 409 ? 'Sealed file changed'
          : opening ? 'This document could not be opened'
            : 'Unable to seal the document';
    sendHtml(res, status, errorPage({ title, message }));
  });

  return app;
}

export function start() {
  const port = Number(process.env.PORT || 8088);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('PORT must be a whole number from 1 to 65535.');
    process.exitCode = 1;
    return;
  }
  const app = createApp();
  const server = app.listen(port, '0.0.0.0');
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set PORT to a free port and start again.`);
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
  server.on('listening', () => {
    const lines = [
      'Online Document QR Code Maker',
      `On this computer: http://localhost:${port}`,
      ...lanIPv4().map((ip) => `On your network:  http://${ip}:${port}`),
    ];
    console.log(lines.join('\n'));
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) start();
