const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader for local dev (no dependency). Railway sets real env vars
// directly and doesn't read this file, so it's gitignored and local-only.
// Only fills in variables that aren't already set, so real env vars always win.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    return;
  }
  raw.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  });
})();

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const MAX_BODY_BYTES = 20 * 1024;
const MAX_TITLE_LEN = 200;
const MAX_NAME_LEN = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const APP_NAME = 'Every Day Is Like Sunday';
const SESSION_COOKIE = 'edils_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_COOLDOWN_MS = 30 * 1000;
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'dataart.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Brevo, with a verified single sender address (confirmed via a code emailed to
// that inbox) — no DNS/domain-admin access needed. Free tier: 300 emails/day,
// no time limit. FROM_EMAIL must be exactly that verified sender address.
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || '';
// Trusted origin for links we email out (e.g. https://every-day.up.railway.app). Without this,
// the origin is derived from the request's Host header, which a caller can spoof — fine for the
// app's own pages, but this value ends up in an email, so prefer an explicit, trusted origin.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const IP_RATE_LIMIT_MAX = 5;
const IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Short-lived magic-link tokens live in memory only — losing them on restart just
// means the user requests a new link, which is fine.
const loginTokens = new Map(); // token -> { email, expiresAt }
const loginCooldown = new Map(); // email -> last request timestamp
const ipRequestLog = new Map(); // ip -> [timestamps]

setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of loginTokens) if (rec.expiresAt < now) loginTokens.delete(token);
  for (const [email, ts] of loginCooldown) if (now - ts > IP_RATE_LIMIT_WINDOW_MS) loginCooldown.delete(email);
  for (const [ip, timestamps] of ipRequestLog) {
    const kept = timestamps.filter((t) => now - t < IP_RATE_LIMIT_WINDOW_MS);
    if (kept.length) ipRequestLog.set(ip, kept); else ipRequestLog.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function ipRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const timestamps = (ipRequestLog.get(ip) || []).filter((t) => now - t < IP_RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= IP_RATE_LIMIT_MAX) {
    ipRequestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  ipRequestLog.set(ip, timestamps);
  return false;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSONFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSONFile(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadEvents() { const d = loadJSONFile(EVENTS_FILE, []); return Array.isArray(d) ? d : []; }
function saveEvents(events) { saveJSONFile(EVENTS_FILE, events); }
function loadSessions() { return loadJSONFile(SESSIONS_FILE, {}); }
function saveSessions(s) { saveJSONFile(SESSIONS_FILE, s); }
function loadProfiles() { return loadJSONFile(PROFILES_FILE, {}); }
function saveProfiles(p) { saveJSONFile(PROFILES_FILE, p); }

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cb) {
  let chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      cb(new Error('Payload too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return cb(null, {});
    try {
      cb(null, JSON.parse(raw));
    } catch (e) {
      cb(new Error('Invalid JSON'));
    }
  });
  req.on('error', (err) => { if (!aborted) cb(err); });
}

function cleanString(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

// ---- Cookies / sessions ----
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx === -1) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const sessions = loadSessions();
  const s = sessions[sid];
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    delete sessions[sid];
    saveSessions(sessions);
    return null;
  }
  return { id: sid, email: s.email };
}

function createSession(email) {
  const sessions = loadSessions();
  const sid = crypto.randomBytes(24).toString('hex');
  sessions[sid] = { email, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
  saveSessions(sessions);
  return sid;
}

function destroySession(sid) {
  const sessions = loadSessions();
  if (sessions[sid]) {
    delete sessions[sid];
    saveSessions(sessions);
  }
}

function sessionCookieHeader(sid, req, maxAgeSeconds) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const secure = proto === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function isAllowedEmail(email) {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
  if (!m) return false;
  return ALLOWED_DOMAINS.indexOf(m[1]) !== -1;
}

// ---- Brevo email (single verified sender — no DNS needed) ----
function parseFromAddress(value) {
  const m = /^(.*)<(.+)>$/.exec(value.trim());
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || APP_NAME, email: m[2].trim() };
  return { name: APP_NAME, email: value.trim() };
}

function sendMagicLinkEmail(email, link) {
  return new Promise((resolve, reject) => {
    if (!BREVO_API_KEY) return reject(new Error('Email sending is not configured on the server (missing BREVO_API_KEY)'));
    if (!FROM_EMAIL) return reject(new Error('FROM_EMAIL is not set — it must be your Brevo-verified sender address'));
    const payload = JSON.stringify({
      sender: parseFromAddress(FROM_EMAIL),
      to: [{ email }],
      subject: `Sign in to ${APP_NAME}`,
      htmlContent: `<p>Click the link below to sign in to <strong>${APP_NAME}</strong>:</p>` +
                   `<p><a href="${link}">${link}</a></p>` +
                   `<p>This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
    });
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
        reject(new Error(`Brevo error ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---- Auth API ----
function handleAuthApi(req, res, parts) {
  if (parts.length === 3 && parts[2] === 'request' && req.method === 'POST') {
    if (ipRateLimited(req)) {
      return sendJSON(res, 429, { error: 'Too many requests. Please try again later.' });
    }
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const email = cleanString(body.email, 200).toLowerCase();
      if (!isAllowedEmail(email)) {
        return sendJSON(res, 403, { error: 'Only certain email addresses can sign in.' });
      }
      const last = loginCooldown.get(email) || 0;
      if (Date.now() - last < LOGIN_COOLDOWN_MS) {
        return sendJSON(res, 429, { error: 'Please wait a bit before requesting another link.' });
      }
      loginCooldown.set(email, Date.now());

      const token = crypto.randomBytes(24).toString('hex');
      loginTokens.set(token, { email, expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS });

      let origin = APP_BASE_URL;
      if (!origin) {
        const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        origin = `${proto}://${host}`;
      }
      const link = `${origin}/api/auth/verify?token=${token}`;

      const sendPromise = BREVO_API_KEY
        ? sendMagicLinkEmail(email, link)
        : Promise.resolve().then(() => {
            console.log(`[dev] BREVO_API_KEY is not set — sign-in link for ${email}:\n${link}`);
          });

      sendPromise.then(() => {
        sendJSON(res, 200, { ok: true, devMode: !BREVO_API_KEY });
      }).catch((e) => {
        sendJSON(res, 502, { error: `Could not send the email: ${e.message}` });
      });
    });
  }

  if (parts.length === 3 && parts[2] === 'verify' && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://placeholder');
    const token = urlObj.searchParams.get('token') || '';
    const rec = loginTokens.get(token);
    loginTokens.delete(token);
    if (!rec || rec.expiresAt < Date.now()) {
      res.writeHead(302, { Location: '/login.html?error=expired' });
      return res.end();
    }
    const sid = createSession(rec.email);
    res.writeHead(302, {
      'Set-Cookie': sessionCookieHeader(sid, req, Math.floor(SESSION_TTL_MS / 1000)),
      Location: '/',
    });
    return res.end();
  }

  if (parts.length === 3 && parts[2] === 'logout' && req.method === 'POST') {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) destroySession(sid);
    res.writeHead(200, {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      'Content-Type': 'application/json; charset=utf-8',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  sendJSON(res, 404, { error: 'Not found' });
}

// ---- Profile API (display name shown next to a session's email) ----
function handleProfileApi(req, res, session) {
  if (req.method === 'GET') {
    const profiles = loadProfiles();
    const name = (profiles[session.email] && profiles[session.email].name) || '';
    return sendJSON(res, 200, { email: session.email, name });
  }
  if (req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const name = cleanString(body.name, MAX_NAME_LEN);
      if (!name) return sendJSON(res, 400, { error: 'Name is required' });
      const profiles = loadProfiles();
      profiles[session.email] = { name };
      saveProfiles(profiles);
      return sendJSON(res, 200, { email: session.email, name });
    });
  }
  sendJSON(res, 404, { error: 'Not found' });
}

// ---- Events API (ownership is the verified session email, not client input) ----
function resolveOwnerName(email, profiles) {
  if (!email) return 'Unknown';
  return (profiles[email] && profiles[email].name) || String(email).split('@')[0];
}

function handleEventsApi(req, res, parts, session) {
  if (parts.length === 2 && req.method === 'GET') {
    const profiles = loadProfiles();
    const events = loadEvents().map((e) => ({
      id: e.id, date: e.date, title: e.title,
      ownerEmail: e.ownerEmail || null,
      ownerName: e.ownerEmail ? resolveOwnerName(e.ownerEmail, profiles) : (e.owner || 'Unknown'),
      mine: !!e.ownerEmail && e.ownerEmail === session.email,
    }));
    return sendJSON(res, 200, events);
  }

  if (parts.length === 2 && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const date = cleanString(body.date, 10);
      const title = cleanString(body.title, MAX_TITLE_LEN);
      if (!DATE_RE.test(date)) return sendJSON(res, 400, { error: 'Invalid date' });
      if (!title) return sendJSON(res, 400, { error: 'Title is required' });

      const events = loadEvents();
      const event = {
        id: crypto.randomUUID(),
        date, title,
        ownerEmail: session.email,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      saveEvents(events);
      const profiles = loadProfiles();
      return sendJSON(res, 201, {
        id: event.id, date: event.date, title: event.title,
        ownerEmail: event.ownerEmail, ownerName: resolveOwnerName(event.ownerEmail, profiles), mine: true,
      });
    });
  }

  if (parts.length === 3 && req.method === 'PUT') {
    const id = parts[2];
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const title = cleanString(body.title, MAX_TITLE_LEN);
      if (!title) return sendJSON(res, 400, { error: 'Title is required' });

      const events = loadEvents();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
      if (events[idx].ownerEmail !== session.email) return sendJSON(res, 403, { error: 'Only the owner can edit this event' });

      events[idx] = { ...events[idx], title, updatedAt: new Date().toISOString() };
      saveEvents(events);
      const profiles = loadProfiles();
      return sendJSON(res, 200, {
        id: events[idx].id, date: events[idx].date, title: events[idx].title,
        ownerEmail: events[idx].ownerEmail, ownerName: resolveOwnerName(events[idx].ownerEmail, profiles), mine: true,
      });
    });
  }

  if (parts.length === 3 && req.method === 'DELETE') {
    const id = parts[2];
    const events = loadEvents();
    const idx = events.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
    if (events[idx].ownerEmail !== session.email) return sendJSON(res, 403, { error: 'Only the owner can delete this event' });

    events.splice(idx, 1);
    saveEvents(events);
    res.writeHead(204);
    return res.end();
  }

  sendJSON(res, 404, { error: 'Not found' });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const PUBLIC_GET_PATHS = new Set(['/login.html']);

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const parts = urlPath.replace(/^\/+/, '').split('/');

  if (parts[0] === 'api' && parts[1] === 'auth') {
    return handleAuthApi(req, res, parts);
  }

  const session = getSession(req);

  if (parts[0] === 'api' && parts[1] === 'profile') {
    if (!session) return sendJSON(res, 401, { error: 'Sign in required' });
    return handleProfileApi(req, res, session);
  }

  if (parts[0] === 'api' && parts[1] === 'events') {
    if (!session) return sendJSON(res, 401, { error: 'Sign in required' });
    return handleEventsApi(req, res, parts, session);
  }

  if (!session && !PUBLIC_GET_PATHS.has(urlPath)) {
    if (req.method === 'GET') {
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
    return sendJSON(res, 401, { error: 'Sign in required' });
  }

  if (session && urlPath === '/login.html') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  serveStatic(req, res);
});

ensureDataDir();
server.listen(PORT, () => {
  console.log(`${APP_NAME} listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Allowed email domains: ${ALLOWED_DOMAINS.join(', ')}`);
  if (!BREVO_API_KEY) console.warn('WARNING: BREVO_API_KEY is not set — sign-in emails cannot be sent.');
});
