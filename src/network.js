import os from 'node:os';

const VIRTUAL_ADAPTER = /vethernet|hyper-v|wsl|virtualbox|vmware|vbox|docker|bluetooth|loopback|npcap|tunnel|pseudo/i;

export function lanIPv4() {
  const all = [];
  const preferred = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const virtual = VIRTUAL_ADAPTER.test(name);
    for (const net of list || []) {
      if (net.internal) continue;
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      all.push(net.address);
      if (!virtual) preferred.push(net.address);
    }
  }
  return preferred.length > 0 ? preferred : all;
}

export function parseHost(host) {
  if (!host || /[\s/@\\]/.test(host)) return null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 1) return null;
    return host.slice(1, end).toLowerCase();
  }
  return host.replace(/:\d+$/, '').toLowerCase();
}

export function allowedHostnames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  for (const ip of lanIPv4()) names.add(ip);
  const hostname = os.hostname().trim().toLowerCase();
  if (hostname) names.add(hostname);
  if (process.env.PUBLIC_HOST) names.add(process.env.PUBLIC_HOST.trim().toLowerCase());
  for (const item of extra) {
    if (!item) continue;
    names.add(String(item).replace(/^::ffff:/i, '').toLowerCase());
  }
  return names;
}

export function isAllowedHost(hostHeader, extra = []) {
  const name = parseHost(hostHeader);
  if (!name) return false;
  return allowedHostnames(extra).has(name);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function normalizePublicOrigin(value) {
  const raw = String(value || '').trim().split(/\s+/)[0];
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  return parsed.origin;
}

export function reachableOrigin(protocol, host, shareLocal = true, publicBase = null) {
  const published = normalizePublicOrigin(publicBase);
  if (published) return published;
  const name = parseHost(host);
  if (!name) return null;
  const safeProtocol = protocol === 'https' ? 'https' : 'http';
  if (!shareLocal || !LOOPBACK.has(name)) return `${safeProtocol}://${host}`;
  const ip = lanIPv4()[0];
  if (!ip) return `${safeProtocol}://${host}`;
  const port = host.startsWith('[') ? /\]:(\d+)$/.exec(host) : /:(\d+)$/.exec(host);
  return port ? `http://${ip}:${port[1]}` : `http://${ip}`;
}

export function documentAddress(previewUrl, { shareLocal = true, publicBase = null } = {}) {
  const parsed = new URL(previewUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Document address must be http or https.');
  }
  if (!parsed.pathname.endsWith('/file')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/file`;
  }
  parsed.search = '';
  parsed.hash = '';
  const published = normalizePublicOrigin(publicBase);
  if (published) {
    const base = new URL(published);
    parsed.protocol = base.protocol;
    parsed.hostname = base.hostname;
    parsed.port = base.port;
  } else if (shareLocal && LOOPBACK.has(parsed.hostname.toLowerCase())) {
    const ip = lanIPv4()[0];
    if (ip) {
      parsed.hostname = ip;
      parsed.protocol = 'http:';
    }
  }
  return parsed.href;
}
