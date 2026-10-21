const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const MAX_BODY_BYTES = 20 * 1024;
const MAX_TITLE_LEN = 200;
const MAX_OWNER_LEN = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveEvents(events) {
  ensureDataDir();
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}

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

function handleEventsApi(req, res, parts) {
  // parts: ['api', 'events'] or ['api', 'events', ':id']
  if (parts.length === 2 && req.method === 'GET') {
    return sendJSON(res, 200, loadEvents());
  }

  if (parts.length === 2 && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const date = cleanString(body.date, 10);
      const title = cleanString(body.title, MAX_TITLE_LEN);
      const owner = cleanString(body.owner, MAX_OWNER_LEN);
      if (!DATE_RE.test(date)) return sendJSON(res, 400, { error: 'Invalid date' });
      if (!title) return sendJSON(res, 400, { error: 'Title is required' });
      if (!owner) return sendJSON(res, 400, { error: 'Owner is required' });

      const events = loadEvents();
      const event = {
        id: crypto.randomUUID(),
        date, title, owner,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      saveEvents(events);
      return sendJSON(res, 201, event);
    });
  }

  if (parts.length === 3 && req.method === 'PUT') {
    const id = parts[2];
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const title = cleanString(body.title, MAX_TITLE_LEN);
      const owner = cleanString(body.owner, MAX_OWNER_LEN);
      if (!title) return sendJSON(res, 400, { error: 'Title is required' });
      if (!owner) return sendJSON(res, 400, { error: 'Owner is required' });

      const events = loadEvents();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
      if (events[idx].owner !== owner) return sendJSON(res, 403, { error: 'Only the owner can edit this event' });

      events[idx] = { ...events[idx], title, updatedAt: new Date().toISOString() };
      saveEvents(events);
      return sendJSON(res, 200, events[idx]);
    });
  }

  if (parts.length === 3 && req.method === 'DELETE') {
    const id = parts[2];
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: err.message });
      const owner = cleanString(body.owner, MAX_OWNER_LEN);

      const events = loadEvents();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
      if (events[idx].owner !== owner) return sendJSON(res, 403, { error: 'Only the owner can delete this event' });

      events.splice(idx, 1);
      saveEvents(events);
      return sendJSON(res, 204, {});
    });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const parts = urlPath.replace(/^\/+/, '').split('/');

  if (parts[0] === 'api' && parts[1] === 'events') {
    return handleEventsApi(req, res, parts);
  }

  serveStatic(req, res);
});

ensureDataDir();
server.listen(PORT, () => {
  console.log(`Every Day Is Like Sunday listening on port ${PORT}`);
  console.log(`Events data file: ${EVENTS_FILE}`);
});
