import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { normalizeOriginalName } from '../src/inspect.js';
import { contentDisposition } from '../src/filesend.js';
import { documentAddress, isAllowedHost, lanIPv4, reachableOrigin } from '../src/network.js';
import { qrPng } from '../src/qr.js';
import { createApp } from '../src/server.js';
import { readMeta, storedFilePath } from '../src/store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function boot(options = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seal-'));
  const app = createApp({ storageDir: dir, rateLimit: false, shareLocal: false, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    dir,
    server,
    base: `http://127.0.0.1:${port}`,
  };
}

async function stop(ctx) {
  await new Promise((resolve, reject) => {
    ctx.server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.promises.rm(ctx.dir, { recursive: true, force: true });
}

async function upload(base, bytes, filename, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('document', new Blob([bytes], { type }), filename);
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

describe('host allow list', () => {
  test('accepts this computer and rejects an outside host', () => {
    const previous = process.env.PUBLIC_HOST;
    delete process.env.PUBLIC_HOST;
    try {
      assert.equal(isAllowedHost('localhost:3000'), true);
      assert.equal(isAllowedHost('127.0.0.1:3000'), true);
      assert.equal(isAllowedHost('evil.example'), false);
      assert.equal(isAllowedHost('bad host'), false);
      assert.equal(reachableOrigin('http', 'localhost:8088', false), 'http://localhost:8088');
      const shared = reachableOrigin('http', 'localhost:8088', true);
      const ip = lanIPv4()[0];
      assert.equal(shared, ip ? `http://${ip}:8088` : 'http://localhost:8088');
      assert.equal(
        documentAddress('http://localhost:8088/d/aaaaaaaaaaaaaaaa', { shareLocal: true }),
        ip ? `http://${ip}:8088/d/aaaaaaaaaaaaaaaa/file` : 'http://localhost:8088/d/aaaaaaaaaaaaaaaa/file',
      );
      const published = 'https://documents.example';
      assert.equal(reachableOrigin('http', 'localhost:8088', true, published), published);
      assert.equal(
        documentAddress(`http://${ip || '127.0.0.1'}:8088/d/aaaaaaaaaaaaaaaa`, { publicBase: published }),
        `${published}/d/aaaaaaaaaaaaaaaa/file`,
      );
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_HOST;
      else process.env.PUBLIC_HOST = previous;
    }
  });
});

describe('sealed documents', () => {
  let ctx;

  before(async () => {
    ctx = await boot();
  });

  after(async () => {
    await stop(ctx);
  });

  test('home page names the product and the footer', async () => {
    const response = await fetch(ctx.base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<h1>Online Document QR Code Maker<\/h1>/);
    assert.match(html, /Made by Shweta Pawar/);
    assert.match(html, /shweta01818@gmail.com/);
    assert.match(html, /same Wi-Fi/);
  });

  test('static files are served', async () => {
    assert.equal((await fetch(`${ctx.base}/css/styles.css`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/js/main.js`)).status, 200);
    const robots = await (await fetch(`${ctx.base}/robots.txt`)).text();
    assert.match(robots, /Disallow: \/d\//);
  });

  test('seals a pdf, previews it, and downloads the original name and bytes', async () => {
    const { response, json } = await upload(ctx.base, PDF, 'Quarterly Report.pdf', 'application/pdf');
    assert.equal(response.status, 201);
    assert.equal(json.originalName, 'Quarterly Report.pdf');
    assert.equal(json.preview, 'pdf');
    assert.equal(json.previewUrl, `${ctx.base}/d/${json.id}/file`);

    const meta = await readMeta(ctx.dir, json.id);
    assert.equal(meta.sealed, true);
    assert.equal(meta.sha256, json.sha256);

    const qr = Buffer.from(await (await fetch(`${ctx.base}/d/${json.id}/qr.png`)).arrayBuffer());
    const expectedQr = Buffer.from(await qrPng(json.previewUrl));
    assert.ok(qr.equals(expectedQr));

    const opened = await fetch(json.previewUrl);
    assert.equal(opened.status, 200);
    assert.match(opened.headers.get('content-type'), /application\/pdf/);
    assert.match(opened.headers.get('content-disposition'), /^inline;/);
    assert.ok(Buffer.from(await opened.arrayBuffer()).equals(PDF));

    const preview = await (await fetch(`${ctx.base}/d/${json.id}`)).text();
    assert.match(preview, /Quarterly Report\.pdf/);
    assert.match(preview, new RegExp(`<iframe src="/d/${json.id}/file"`));
    assert.doesNotMatch(preview, /data-progress-src/);
    assert.match(preview, new RegExp(`href="/d/${json.id}/download"`));
    assert.match(preview, /Made by Shweta Pawar/);
    assert.match(preview, /shweta01818@gmail.com/);

    const ready = await (await fetch(`${ctx.base}/d/${json.id}/ready`)).text();
    assert.match(ready, /QR code ready/);
    assert.match(ready, /Quarterly Report\.pdf/);
    assert.match(ready, new RegExp(`src="/d/${json.id}/qr.png"`));
    assert.match(ready, new RegExp(`href="/d/${json.id}/download"`));
    assert.match(ready, new RegExp(json.previewUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const ranged = await fetch(`${ctx.base}/d/${json.id}/file`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(ranged.status, 206);
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '%PDF-');

    const download = await fetch(`${ctx.base}/d/${json.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /application\/pdf/);
    assert.match(download.headers.get('content-disposition'), /Quarterly Report\.pdf/);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(PDF));

    await assert.rejects(fs.promises.writeFile(storedFilePath(ctx.dir, json.id), Buffer.from('changed')));

    const denied = await fetch(`${ctx.base}/d/${json.id}`, {
      method: 'PUT',
      headers: { Accept: 'application/json' },
    });
    assert.equal(denied.status, 405);
    const again = await fetch(`${ctx.base}/d/${json.id}/download`);
    assert.ok(Buffer.from(await again.arrayBuffer()).equals(PDF));
  });

  test('a second seal does not replace the first file', async () => {
    const first = await upload(ctx.base, PDF, 'First Copy.pdf', 'application/pdf');
    const second = await upload(ctx.base, PDF, 'Second Copy.pdf', 'application/pdf');
    assert.notEqual(first.json.id, second.json.id);
    const body = Buffer.from(await (await fetch(`${ctx.base}/d/${first.json.id}/download`)).arrayBuffer());
    assert.ok(body.equals(PDF));
    assert.match(
      (await (await fetch(`${ctx.base}/d/${first.json.id}/download`)).headers).get('content-disposition'),
      /First Copy\.pdf/,
    );
  });

  test('previews an image and keeps a unicode file name', async () => {
    const { response, json } = await upload(ctx.base, PNG, 'विवरण.png', 'image/png');
    assert.equal(response.status, 201);
    assert.equal(json.originalName, 'विवरण.png');
    assert.equal(json.preview, 'image');
    const html = await (await fetch(`${ctx.base}/d/${json.id}`)).text();
    assert.match(html, /विवरण\.png/);
    assert.match(html, /<img/);
    const download = await fetch(`${ctx.base}/d/${json.id}/download`);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.match(download.headers.get('content-disposition'), new RegExp(encodeURIComponent('विवरण.png')));
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(PNG));
  });

  test('escapes text preview and file names', async () => {
    const text = await upload(ctx.base, Buffer.from('<script>alert(1)</script>'), 'notes.txt', 'text/plain');
    assert.equal(text.response.status, 201);
    const html = await (await fetch(`${ctx.base}/d/${text.json.id}`)).text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(html.includes('<script>alert(1)</script>'), false);

    const named = await upload(ctx.base, PDF, '<img src=x>.pdf', 'application/pdf');
    assert.equal(named.response.status, 201);
    const preview = await (await fetch(`${ctx.base}/d/${named.json.id}`)).text();
    assert.match(preview, /&lt;img src=x&gt;\.pdf/);
    assert.equal(preview.includes('<img src=x>'), false);
  });

  test('downloads an office document under its original name without a browser preview', async () => {
    const bytes = Buffer.from('PK\u0003\u0004 offer');
    const { response, json } = await upload(ctx.base, bytes, 'Offer Letter.docx');
    assert.equal(response.status, 201);
    assert.equal(json.preview, 'none');
    const html = await (await fetch(`${ctx.base}/d/${json.id}`)).text();
    assert.match(html, /Offer Letter\.docx/);
    assert.equal(html.includes('<iframe'), false);
    const download = await fetch(`${ctx.base}/d/${json.id}/download`);
    assert.match(download.headers.get('content-disposition'), /Offer Letter\.docx/);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(bytes));
    const opened = await fetch(json.previewUrl);
    assert.equal(opened.status, 200);
    assert.match(opened.headers.get('content-disposition'), /attachment/);
    assert.match(opened.headers.get('content-disposition'), /Offer Letter\.docx/);
    assert.ok(Buffer.from(await opened.arrayBuffer()).equals(bytes));
  });

  test('refuses executables, web pages, empty files, and renamed files', async () => {
    const exe = await upload(ctx.base, Buffer.from('MZ'), 'run.exe');
    assert.equal(exe.response.status, 400);
    const html = await upload(ctx.base, Buffer.from('<html></html>'), 'page.html');
    assert.equal(html.response.status, 400);
    const empty = await upload(ctx.base, Buffer.alloc(0), 'empty.pdf', 'application/pdf');
    assert.equal(empty.response.status, 400);
    const fake = await upload(ctx.base, Buffer.from('not a pdf'), 'notes.pdf', 'application/pdf');
    assert.equal(fake.response.status, 400);
  });

  test('a missing document is a not-found page with the footer', async () => {
    const response = await fetch(`${ctx.base}/d/aaaaaaaaaaaaaaaa`);
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /This document is not here/);
    assert.match(html, /Made by Shweta Pawar/);
    assert.match(html, /shweta01818@gmail.com/);
  });

  test('a form post redirects to the QR page', async () => {
    const form = new FormData();
    form.append('document', new Blob([PDF], { type: 'application/pdf' }), 'Manual.pdf');
    const response = await fetch(`${ctx.base}/api/documents`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /^\/d\/[A-Za-z0-9_-]{16}\/ready$/);
  });

  test('an altered file is not served', async () => {
    const { json } = await upload(ctx.base, PDF, 'Locked.pdf', 'application/pdf');
    const file = storedFilePath(ctx.dir, json.id);
    await fs.promises.chmod(file, 0o666);
    const handle = await fs.promises.open(file, 'r+');
    await handle.write(Buffer.from('XXXX'), 0, 4, 0);
    await handle.close();
    const response = await fetch(`${ctx.base}/d/${json.id}/download`);
    assert.equal(response.status, 409);
    const text = await response.text();
    assert.match(text, /altered/i);
    assert.equal(text.includes('XXXX'), false);
  });
});

describe('file names', () => {
  test('control characters cannot change the saved name or the download header', () => {
    assert.equal(normalizeOriginalName('bad\r\nname.pdf'), 'badname.pdf');
    const header = contentDisposition('attachment', 'bad\r\nname.pdf');
    assert.equal(header.includes('\n'), false);
    assert.equal(header.includes('\r'), false);
    assert.match(header, /badname\.pdf/);
  });
});

describe('shared address', () => {
  test('a code made on localhost points other people at the document', async () => {
    const ctx = await boot({ shareLocal: true });
    try {
      const { port } = ctx.server.address();
      const { response, json } = await upload(`http://127.0.0.1:${port}`, PDF, 'Shared.pdf', 'application/pdf');
      assert.equal(response.status, 201);
      const ip = lanIPv4()[0];
      const origin = ip ? `http://${ip}:${port}` : `http://127.0.0.1:${port}`;
      assert.equal(json.previewUrl, `${origin}/d/${json.id}/file`);
      const qr = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/d/${json.id}/qr.png`)).arrayBuffer());
      assert.ok(qr.equals(Buffer.from(await qrPng(json.previewUrl))));
      const opened = await fetch(`http://127.0.0.1:${port}/d/${json.id}/file`);
      assert.equal(opened.headers.get('content-type'), 'application/pdf');
      assert.ok(Buffer.from(await opened.arrayBuffer()).equals(PDF));
    } finally {
      await stop(ctx);
    }
  });
});

describe('upload limit', () => {
  test('rejects a file over the configured size', async () => {
    const ctx = await boot({ maxBytes: 64 });
    try {
      const { response, json } = await upload(ctx.base, Buffer.alloc(65, 1), 'big.txt', 'text/plain');
      assert.equal(response.status, 413);
      assert.match(json.error, /larger than/i);
    } finally {
      await stop(ctx);
    }
  });
});
