import fs from 'node:fs';

export function contentDisposition(type, filename) {
  const cleaned = String(filename).replace(/[\r\n]/g, '');
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function pipeFile(req, res, abs, { mime, filename, inline, size }) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

  const range = req.headers.range;
  if (range && !range.includes(',')) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null && end === null) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    if (start === null) {
      start = Math.max(size - end, 0);
      end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
