const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'audit-events.jsonl');

function safeString(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function createEvent(payload = {}) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action: payload.action || 'unknown_action',
    status: payload.status || 'success',
    actorLogin: safeString(payload.actorLogin),
    actorDisplayName: safeString(payload.actorDisplayName),
    actorDn: safeString(payload.actorDn),
    sourceIp: safeString(payload.sourceIp),
    userAgent: safeString(payload.userAgent),
    scopeType: safeString(payload.scopeType),
    scopeDn: safeString(payload.scopeDn),
    targetDn: safeString(payload.targetDn),
    message: safeString(payload.message),
    details: payload.details || {}
  };
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(EVENTS_FILE);
  } catch {
    await fs.writeFile(EVENTS_FILE, '', 'utf8');
  }
}

async function logEvent(payload = {}) {
  const event = createEvent(payload);
  await ensureStore();
  await fs.appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

function parseLines(raw = '') {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readEvents(limit = 200) {
  await ensureStore();
  const raw = await fs.readFile(EVENTS_FILE, 'utf8');
  const events = parseLines(raw).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return events.slice(0, limit);
}

async function getObjectEvents(dn, limit = 200) {
  const normalized = safeString(dn).toLowerCase();
  if (!normalized) return [];
  const events = await readEvents(limit * 5);
  return events
    .filter((event) => {
      const scopeDn = safeString(event.scopeDn).toLowerCase();
      const targetDn = safeString(event.targetDn).toLowerCase();
      return scopeDn === normalized || targetDn === normalized;
    })
    .slice(0, limit);
}

async function getRecentLoginEvents(limit = 100) {
  const events = await readEvents(limit * 5);
  return events
    .filter((event) => event.action === 'login' || event.action === 'logout')
    .slice(0, limit);
}

module.exports = {
  logEvent,
  readEvents,
  getObjectEvents,
  getRecentLoginEvents
};
