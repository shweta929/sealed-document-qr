const form = document.querySelector('#seal-form');
const dropzone = document.querySelector('#dropzone');
const input = document.querySelector('#document');
const chosen = document.querySelector('#file-chosen');
const dropTitle = document.querySelector('#drop-title');
const dropSub = document.querySelector('#drop-sub');
const submit = document.querySelector('#submit');
const alertBox = document.querySelector('#form-alert');
const panel = document.querySelector('.panel');
const result = document.querySelector('#result');

if (form && input && submit && result && panel) {
  function showError(message) {
    if (!alertBox) return;
    alertBox.hidden = false;
    alertBox.textContent = message;
  }

  function clearError() {
    if (!alertBox) return;
    alertBox.hidden = true;
    alertBox.textContent = '';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showChosen(file) {
    if (chosen) {
      chosen.hidden = false;
      chosen.textContent = `${file.name} · ${formatSize(file.size)}`;
    }
    if (dropTitle) dropTitle.textContent = file.name;
    if (dropSub) dropSub.textContent = '✨ Ready';
    dropzone?.classList.add('has-file');
  }

  input.addEventListener('change', () => {
    clearError();
    const file = input.files && input.files[0];
    if (file) showChosen(file);
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });

  dropzone?.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      showError('Drop one file only.');
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(files[0]);
    input.files = transfer.files;
    clearError();
    showChosen(files[0]);
  });

  async function showResult(data) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(data.id)) {
      throw new Error('The server returned an unexpected document id.');
    }
    const pagePath = `/d/${data.id}`;
    const filePath = `${pagePath}/file`;
    let shown = new URL(filePath, window.location.origin).href;
    try {
      const parsed = new URL(data.previewUrl);
      const sameDocument = (parsed.pathname === pagePath || parsed.pathname === filePath)
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && !parsed.username
        && !parsed.search
        && !parsed.hash;
      if (sameDocument) shown = parsed.href;
    } catch {
      shown = new URL(filePath, window.location.origin).href;
    }

    const name = document.querySelector('#result-name');
    const link = document.querySelector('#result-link');
    const open = document.querySelector('#result-open');
    const download = document.querySelector('#result-download');
    const qrFile = document.querySelector('#result-qr-file');
    const qr = document.querySelector('#result-qr');
    const size = document.querySelector('#result-size');
    const when = document.querySelector('#result-when');
    const hash = document.querySelector('#result-hash');
    if (name) name.textContent = data.originalName || 'Document';
    if (link) {
      link.href = shown;
      link.textContent = shown;
    }
    if (open) open.href = pagePath;
    if (download) {
      download.href = `${pagePath}/download`;
      download.setAttribute('aria-label', `Download ${data.originalName || 'document'}`);
    }
    if (qrFile) qrFile.href = `${pagePath}/qr.png?download=1`;
    if (size) size.textContent = data.sizeLabel || '';
    if (when) when.textContent = data.createdLabel || '';
    if (hash) hash.textContent = data.sha256 || '';
    const frame = qr ? qr.closest('.qr-frame') : null;
    if (frame) frame.classList.add('is-loading');
    if (qr) {
      qr.alt = `QR code for ${data.originalName || 'the sealed document'}`;
      await new Promise((resolve, reject) => {
        qr.addEventListener('load', () => resolve(), { once: true });
        qr.addEventListener('error', () => reject(new Error('The QR code could not be loaded. Try again.')), { once: true });
        qr.src = `${pagePath}/qr.png`;
      });
      if (frame) frame.classList.remove('is-loading');
    }
    panel.classList.add('is-sealed');
    result.hidden = false;
    result.scrollIntoView({ block: 'start' });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (document.body.classList.contains('is-busy')) return;
    clearError();
    const file = input.files && input.files[0];
    if (!file) {
      showError('Choose a file to seal.');
      return;
    }
    const maxBytes = Number(form.dataset.maxBytes);
    if (Number.isFinite(maxBytes) && file.size > maxBytes) {
      showError(`That file is larger than ${form.dataset.maxLabel || 'the limit'}.`);
      return;
    }
    if (file.size === 0) {
      showError('The file is empty.');
      return;
    }
    const ui = window.siteUi;
    submit.disabled = true;
    const label = submit.querySelector('.button-label');
    if (label) label.textContent = '✨ Creating…';
    if (ui) ui.busy('Sealing the document', { loaded: 0, total: file.size || 1 });
    try {
      const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.upload.addEventListener('progress', (event) => {
          if (ui && event.lengthComputable) {
            ui.busy('Sealing the document', { loaded: event.loaded, total: event.total });
          }
        });
        xhr.addEventListener('error', () => reject(new TypeError('network')));
        xhr.addEventListener('load', () => resolve(xhr));
        xhr.send(new FormData(form));
      });
      const type = response.getResponseHeader('content-type') || '';
      let payload = {};
      if (type.includes('application/json')) {
        try {
          payload = JSON.parse(response.responseText || '{}');
        } catch {
          throw new Error('The server sent an unexpected response.');
        }
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(payload.error || 'The document could not be sealed.');
      }
      if (ui) ui.busy('Creating the QR code', { loaded: 1, total: 1 });
      await showResult(payload);
    } catch (error) {
      const message = ui
        ? ui.readableError(error, 'The document could not be sealed.')
        : (error.message || 'The document could not be sealed.');
      showError(message);
      submit.disabled = false;
      if (label) label.textContent = '✨ Create QR code';
    } finally {
      if (ui) ui.busy('');
    }
  });
}
