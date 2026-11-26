const workStatus = document.querySelector('#work-status');
const workLabel = document.querySelector('#work-label');
const workPercent = document.querySelector('#work-percent');
const workTime = document.querySelector('#work-time');
const workBar = document.querySelector('#work-bar');
const pageAlert = document.querySelector('#page-alert');

let job = null;
let clock = 0;

function waitText(loaded, total, started) {
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const elapsed = (performance.now() - started) / 1000;
  if (total > 0 && loaded >= total) {
    const finishing = Math.max(1, Math.round(elapsed));
    const noun = finishing === 1 ? 'second' : 'seconds';
    return { percent: 100, time: `Finishing · ${finishing} ${noun}` };
  }
  if (loaded > 0 && total > loaded && elapsed >= 0.25) {
    const left = Math.max(1, Math.ceil(((total - loaded) / loaded) * elapsed));
    const noun = left === 1 ? 'second' : 'seconds';
    return { percent, time: `${left} ${noun} left` };
  }
  return { percent, time: 'Calculating time' };
}

function paintJob() {
  if (!job) return;
  const view = waitText(job.loaded, job.total, job.doneAt || job.started);
  if (workPercent) workPercent.textContent = `${view.percent}%`;
  if (workTime) workTime.textContent = view.time;
  if (workBar) workBar.style.width = `${view.percent}%`;
}

function busy(message, progress) {
  if (!workStatus || !workLabel) return;
  if (!message) {
    window.clearInterval(clock);
    clock = 0;
    job = null;
    workStatus.hidden = true;
    workLabel.textContent = '';
    document.body.classList.remove('is-busy');
    document.body.removeAttribute('aria-busy');
    return;
  }
  if (!job) {
    job = { loaded: 0, total: 0, started: performance.now(), doneAt: 0 };
    clock = window.setInterval(paintJob, 200);
  }
  workLabel.textContent = message;
  if (progress) {
    job.loaded = progress.loaded;
    job.total = progress.total;
    if (progress.total > 0 && progress.loaded >= progress.total && !job.doneAt) {
      job.doneAt = performance.now();
    }
  }
  workStatus.hidden = false;
  document.body.classList.add('is-busy');
  document.body.setAttribute('aria-busy', 'true');
  paintJob();
}

function showPageError(message) {
  if (!pageAlert) return;
  pageAlert.hidden = false;
  pageAlert.textContent = message;
}

function clearPageError() {
  if (!pageAlert) return;
  pageAlert.hidden = true;
  pageAlert.textContent = '';
}

function readableError(error, fallback) {
  if (!error) return fallback;
  if (error.name === 'TypeError') {
    return 'The site could not be reached. Leave this page open and try again.';
  }
  return error.message || fallback;
}

function revealMedia(media) {
  const frame = media.closest('.preview-frame, .qr-frame');
  if (!frame || !frame.classList.contains('is-loading')) return;
  const finish = () => frame.classList.remove('is-loading');
  const fail = () => {
    frame.classList.remove('is-loading');
    frame.classList.add('is-failed');
    const status = frame.querySelector('.frame-status');
    if (status) status.textContent = 'This preview could not be shown. Use the download button.';
  };
  if (media.tagName === 'IMG' && media.complete) {
    if (media.naturalWidth > 0) finish();
    else fail();
    return;
  }
  media.addEventListener('load', finish, { once: true });
  media.addEventListener('error', fail, { once: true });
}

document.querySelectorAll('.preview-frame img, .preview-frame iframe, .qr-frame img').forEach(revealMedia);

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  if (link.origin !== window.location.origin) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (link.hasAttribute('data-download')) return;
  if (document.body.classList.contains('is-busy')) {
    event.preventDefault();
    return;
  }
  busy('Opening', { loaded: 0, total: 0 });
});

window.siteUi = {
  busy,
  showPageError,
  clearPageError,
  readableError,
};
