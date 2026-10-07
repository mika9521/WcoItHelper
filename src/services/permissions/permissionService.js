// Small JSON-file database for "user permissions": named, described
// entries mapped to one or more AD groups. Used by the new-user wizard.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../../utils/errors');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'permissions.json');

// Serialises writes so concurrent requests cannot lose each other's changes.
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function load() {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { permissions: Array.isArray(data.permissions) ? data.permissions : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { permissions: [] };
    throw new AppError(`Nie można odczytać bazy uprawnień (${DB_FILE}): ${error.message}`, 500);
  }
}

// Write to a temp file and rename, so a crash never leaves a half-written DB.
async function save(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, DB_FILE);
}

function sanitize(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new AppError('Nazwa uprawnienia jest wymagana', 400);
  if (name.length > 120) throw new AppError('Nazwa uprawnienia może mieć maks. 120 znaków', 400);
  const seen = new Set();
  const groups = (Array.isArray(input.groups) ? input.groups : [])
    .map((g) => (typeof g === 'string' ? { dn: g } : g))
    .map((g) => ({ dn: String(g?.dn || '').trim(), name: String(g?.name || '').trim() }))
    .filter((g) => {
      const key = g.dn.toLowerCase();
      if (!g.dn || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!groups.length) throw new AppError('Wybierz co najmniej jedną grupę AD', 400);
  return {
    name,
    description: String(input.description || '').trim().slice(0, 1000),
    category: String(input.category || '').trim().slice(0, 80),
    groups
  };
}

function sortByName(list) {
  return [...list].sort((a, b) => (a.category || '').localeCompare(b.category || '', 'pl') || a.name.localeCompare(b.name, 'pl'));
}

async function listPermissions() {
  return sortByName((await load()).permissions);
}

async function createPermission(input, actor = '') {
  return withLock(async () => {
    const data = await load();
    const clean = sanitize(input);
    if (data.permissions.some((p) => p.name.toLowerCase() === clean.name.toLowerCase())) {
      throw new AppError(`Uprawnienie „${clean.name}” już istnieje`, 409);
    }
    const now = new Date().toISOString();
    const permission = { id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now, updatedBy: actor };
    data.permissions.push(permission);
    await save(data);
    return permission;
  });
}

async function updatePermission(id, input, actor = '') {
  return withLock(async () => {
    const data = await load();
    const index = data.permissions.findIndex((p) => p.id === id);
    if (index === -1) throw new AppError('Nie znaleziono uprawnienia', 404);
    const clean = sanitize(input);
    if (data.permissions.some((p) => p.id !== id && p.name.toLowerCase() === clean.name.toLowerCase())) {
      throw new AppError(`Uprawnienie „${clean.name}” już istnieje`, 409);
    }
    const before = data.permissions[index];
    data.permissions[index] = { ...before, ...clean, updatedAt: new Date().toISOString(), updatedBy: actor };
    await save(data);
    return { before, after: data.permissions[index] };
  });
}

async function deletePermission(id) {
  return withLock(async () => {
    const data = await load();
    const permission = data.permissions.find((p) => p.id === id);
    if (!permission) throw new AppError('Nie znaleziono uprawnienia', 404);
    data.permissions = data.permissions.filter((p) => p.id !== id);
    await save(data);
    return permission;
  });
}

async function getPermissionsByIds(ids = []) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!wanted.size) return [];
  const { permissions } = await load();
  const found = permissions.filter((p) => wanted.has(p.id));
  if (found.length !== wanted.size) {
    throw new AppError('Część wybranych uprawnień nie istnieje (mogły zostać usunięte). Odśwież listę uprawnień.', 400);
  }
  return found;
}

module.exports = {
  listPermissions,
  createPermission,
  updatePermission,
  deletePermission,
  getPermissionsByIds
};
