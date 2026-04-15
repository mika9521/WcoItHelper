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

function inDateRange(timestamp, fromDate, toDate) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return false;
  if (fromDate && value < fromDate) return false;
  if (toDate && value > toDate) return false;
  return true;
}

async function queryEvents(options = {}) {
  const {
    q = '',
    action = '',
    status = '',
    from = '',
    to = '',
    page = 1,
    pageSize = 20
  } = options;

  const allEvents = await readEvents(100000);
  const qNorm = safeString(q).toLowerCase().trim();
  const actionNorm = safeString(action).toLowerCase().trim();
  const statusNorm = safeString(status).toLowerCase().trim();
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : null;
  const toDate = to ? new Date(`${to}T23:59:59.999Z`) : null;

  const filtered = allEvents.filter((event) => {
    if (actionNorm && safeString(event.action).toLowerCase() !== actionNorm) return false;
    if (statusNorm && safeString(event.status).toLowerCase() !== statusNorm) return false;
    if ((fromDate || toDate) && !inDateRange(event.timestamp, fromDate, toDate)) return false;

    if (!qNorm) return true;
    const haystack = [
      event.actorLogin,
      event.actorDisplayName,
      event.action,
      event.status,
      event.message,
      event.scopeDn,
      event.targetDn
    ].map((x) => safeString(x).toLowerCase()).join(' ');
    return haystack.includes(qNorm);
  });

  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const total = filtered.length;
  const totalPages = Math.max(Math.ceil(total / safePageSize), 1);
  const start = (safePage - 1) * safePageSize;
  const rows = filtered.slice(start, start + safePageSize);

  return {
    rows,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages
    }
  };
}

module.exports = {
  logEvent,
  readEvents,
  getObjectEvents,
  getRecentLoginEvents,
  queryEvents
};
