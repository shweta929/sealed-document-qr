import { formatBytes, formatLimit, formatWhen } from './format.js';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function header() {
  return `<header class="site-header">
    <a class="brand" href="/">
      <img class="brand-logo" src="/logo.webp" width="2172" height="724" alt="Document QR Seal">
    </a>
  </header>`;
}

function footer() {
  return `<footer class="site-footer">
    <p>Made by Shweta Pawar</p>
    <p>Contact: <a href="mailto:shweta01818@gmail.com">shweta01818@gmail.com</a></p>
  </footer>`;
}

function layout({ title, main, home = false }) {
  const scripts = home
    ? '<script src="/js/ui.js?v=5" defer></script><script src="/js/main.js?v=5" defer></script>'
    : '<script src="/js/ui.js?v=5" defer></script>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="description" content="Upload one document and receive a QR code that opens a preview and downloads the original file. The sealed file cannot be replaced.">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.webp" type="image/webp">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Sans+3:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/styles.css?v=7">
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  ${header()}
  <main id="content" class="shell">
    <p id="page-alert" class="notice notice-warn" role="alert" hidden></p>
    ${main}
  </main>
  ${footer()}
  <div id="work-status" class="work-status" hidden>
    <div class="work-card" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <div class="work-copy">
        <p id="work-label" class="work-label"></p>
        <p id="work-percent" class="work-percent">0%</p>
        <p id="work-time" class="work-time">Calculating time</p>
        <div class="work-track" aria-hidden="true"><span id="work-bar"></span></div>
      </div>
    </div>
  </div>
  ${scripts}
</body>
</html>`;
}

function facts(meta) {
  return `<dl class="facts">
    <div><dt>📦 Size</dt><dd>${escapeHtml(formatBytes(meta.size))}</dd></div>
    <div><dt>🗓️ Sealed</dt><dd>${escapeHtml(formatWhen(meta.createdAt))}</dd></div>
    <div><dt>🆔 ID</dt><dd><code>${escapeHtml(meta.id)}</code></dd></div>
    <div><dt>🔒 Check</dt><dd><code>${escapeHtml(meta.sha256)}</code></dd></div>
  </dl>`;
}

function warningBlock(urls) {
  if (!urls) return '';
  if (urls.length === 0) {
    return `<div class="notice notice-warn">
      <p>💻 This computer only.</p>
    </div>`;
  }
  const links = urls.map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`).join('');
  return `<div class="notice notice-warn">
    <p>📶 same Wi-Fi · this computer stays on</p>
    <ul>${links}</ul>
  </div>`;
}

function publicBlock(publicUrl) {
  return `<div class="notice">
    <p>🌍 Anyone with the QR · this computer stays on</p>
    <ul><li><a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></li></ul>
  </div>`;
}

export function homePage({ maxBytes, warningUrls, publicUrl = null }) {
  const limit = formatLimit(maxBytes);
  const fine = publicUrl
    ? '🔐 Locked · 🌍 anyone with the QR'
    : '🔐 Locked once you create it';
  return layout({
    title: 'Online Document QR Code Maker',
    home: true,
    main: `<div class="layout">
      <section class="intro">
        <p class="eyebrow">✨ One file · one QR</p>
        <h1>Online Document QR Code Maker</h1>
        <p class="lead">Drop a file. Share the QR. They see the document.</p>
        <ol class="steps">
          <li><span class="emoji" aria-hidden="true">📄</span> Upload</li>
          <li><span class="emoji" aria-hidden="true">🔐</span> Seal</li>
          <li><span class="emoji" aria-hidden="true">📱</span> Scan</li>
        </ol>
        ${publicUrl ? publicBlock(publicUrl) : warningBlock(warningUrls)}
      </section>
      <section class="panel" aria-labelledby="seal-heading">
        <h2 id="seal-heading">✨ Make a QR</h2>
        <p id="form-alert" class="notice notice-warn" role="alert" hidden></p>
        <form id="seal-form" action="/api/documents" method="post" enctype="multipart/form-data" data-max-bytes="${maxBytes}" data-max-label="${escapeHtml(limit)}">
          <label class="dropzone" id="dropzone">
            <input id="document" name="document" type="file" required>
            <span class="drop-copy">
              <span class="drop-emoji" aria-hidden="true">📂</span>
              <span class="drop-title" id="drop-title">Drop a file</span>
              <span class="drop-sub" id="drop-sub">or tap · ${escapeHtml(limit)} max</span>
            </span>
          </label>
          <p class="file-chosen" id="file-chosen" hidden></p>
          <button class="button" id="submit" type="submit"><span class="button-label">✨ Create QR code</span></button>
          <p class="fine">${fine}</p>
        </form>
        <div id="result" class="result" hidden>
          <p class="eyebrow">🎉 QR code ready</p>
          <h2 id="result-name"></h2>
          <p class="sealed-flag">🔐 Sealed</p>
          <div class="qr-frame">
            <p class="frame-status"><span class="frame-label">Loading the QR code</span></p>
            <img id="result-qr" alt="QR code for the sealed document" width="280" height="280">
          </div>
          <p class="permalink"><a id="result-link" href=""></a></p>
          <div class="actions">
            <a class="button" id="result-open" href="">👀 Preview</a>
            <a class="button button-secondary" id="result-download" data-download data-loading="Preparing the download" href="">⬇️ Download</a>
            <a class="button button-secondary" id="result-qr-file" data-download data-loading="Preparing the QR image" href="">🖼️ QR image</a>
          </div>
          <dl class="facts">
            <div><dt>📦 Size</dt><dd id="result-size"></dd></div>
            <div><dt>🗓️ Sealed</dt><dd id="result-when"></dd></div>
            <div><dt>🔒 Check</dt><dd><code id="result-hash"></code></dd></div>
          </dl>
          <p class="fine"><a href="/">➕ Another file</a></p>
        </div>
      </section>
    </div>`,
  });
}

export function readyPage(meta, documentUrl = meta.previewUrl) {
  const id = meta.id;
  return layout({
    title: `QR code ready · ${meta.originalName}`,
    main: `<article class="sheet sheet-split">
      <div class="sheet-copy">
        <p class="eyebrow">🎉 QR code ready</p>
        <h1>${escapeHtml(meta.originalName)}</h1>
        <p class="sealed-flag">🔐 Sealed</p>
        <p class="permalink"><a href="${escapeHtml(documentUrl)}">${escapeHtml(documentUrl)}</a></p>
        <div class="actions">
          <a class="button" href="/d/${id}">👀 Preview</a>
          <a class="button button-secondary" data-download data-loading="Preparing the download" href="/d/${id}/download">⬇️ Download</a>
          <a class="button button-secondary" data-download data-loading="Preparing the QR image" href="/d/${id}/qr.png?download=1">🖼️ QR image</a>
        </div>
        ${facts(meta)}
        <p class="fine">📱 Scan opens the file · ${escapeHtml(meta.originalName)}</p>
        <p class="fine"><a href="/">➕ Another file</a></p>
      </div>
      <div class="qr-frame is-loading">
        <p class="frame-status" role="status"><span class="frame-label">Loading the QR code</span></p>
        <img src="/d/${id}/qr.png" width="280" height="280" alt="${escapeHtml(`QR code for ${meta.originalName}`)}">
      </div>
    </article>`,
  });
}

function previewBody(meta) {
  const id = meta.id;
  const openFile = `<p class="fine"><a href="/d/${id}/file">🔍 Full preview</a></p>`;
  if (meta.preview === 'image') {
    return `<div class="preview-frame is-loading"><p class="frame-status" role="status"><span class="frame-label">Loading preview</span></p><img src="/d/${id}/file" alt="${escapeHtml(meta.originalName)}"></div>${openFile}`;
  }
  if (meta.preview === 'pdf') {
    return `<div class="preview-frame preview-frame-pdf"><iframe src="/d/${id}/file" title="${escapeHtml(`Preview of ${meta.originalName}`)}"></iframe></div>${openFile}`;
  }
  if (meta.preview === 'text' && typeof meta.text === 'string') {
    return `<div class="preview-frame"><pre>${escapeHtml(meta.text)}</pre></div>`;
  }
  return `<div class="preview-frame preview-empty"><p>📥 Use download. This file opens in its own app.</p></div>`;
}

export function previewPage(meta) {
  const id = meta.id;
  return layout({
    title: `${meta.originalName} · Online Document QR Code Maker`,
    main: `<article class="preview-page preview-split">
      <div class="sheet-copy">
        <p class="eyebrow">📄 Sealed file</p>
        <h1>${escapeHtml(meta.originalName)}</h1>
        <p class="sealed-flag">🔐 Sealed</p>
        <div class="actions">
          <a class="button" data-download data-loading="Preparing the download" href="/d/${id}/download" aria-label="${escapeHtml(`Download ${meta.originalName}`)}">⬇️ Download</a>
          <a class="button button-secondary" href="/d/${id}/ready">🔳 QR code</a>
        </div>
        ${facts(meta)}
      </div>
      <div class="preview-stage">
        ${previewBody(meta)}
      </div>
    </article>`,
  });
}

export function errorPage({ title, message }) {
  return layout({
    title: `${title} · Online Document QR Code Maker`,
    main: `<article class="sheet">
      <p class="eyebrow">⚠️ Notice</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(message)}</p>
      <p><a class="button" href="/">🏠 Home</a></p>
    </article>`,
  });
}

export function sendHtml(res, status, html) {
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(html);
}
