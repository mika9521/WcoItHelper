// Tiny JSON-file "table": one file per collection in data/, atomic writes
// (temp file + rename) and serialised updates so concurrent requests cannot
// overwrite each other.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../../utils/errors');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

function createJsonStore({ file, key, label, sanitize, sort }) {
  const dbFile = path.join(DATA_DIR, file);
  let queue = Promise.resolve();
  const withLock = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(dbFile, 'utf8'));
      return Array.isArray(data[key]) ? data[key] : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new AppError(`Nie można odczytać bazy (${dbFile}): ${error.message}`, 500);
    }
  }

  async function save(items) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${dbFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ [key]: items }, null, 2), 'utf8');
    await fs.rename(tmp, dbFile);
  }

  const assertUniqueName = (items, name, exceptId = null) => {
    if (items.some((it) => it.id !== exceptId && it.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError(`${label} „${name}” już istnieje`, 409);
    }
  };

  return {
    async list() {
      return sort([...(await load())]);
    },
    async create(input, actor = '') {
      return withLock(async () => {
        const items = await load();
        const clean = sanitize(input);
        assertUniqueName(items, clean.name);
        const now = new Date().toISOString();
        const item = { id: crypto.randomUUID(), ...clean, createdAt: now, updatedAt: now, updatedBy: actor };
        items.push(item);
        await save(items);
        return item;
      });
    },
    async update(id, input, actor = '') {
      return withLock(async () => {
        const items = await load();
        const index = items.findIndex((it) => it.id === id);
        if (index === -1) throw new AppError(`Nie znaleziono: ${label.toLowerCase()}`, 404);
        const clean = sanitize(input);
        assertUniqueName(items, clean.name, id);
        const before = items[index];
        items[index] = { ...before, ...clean, updatedAt: new Date().toISOString(), updatedBy: actor };
        await save(items);
        return { before, after: items[index] };
      });
    },
    async remove(id) {
      return withLock(async () => {
        const items = await load();
        const item = items.find((it) => it.id === id);
        if (!item) throw new AppError(`Nie znaleziono: ${label.toLowerCase()}`, 404);
        await save(items.filter((it) => it.id !== id));
        return item;
      });
    },
    async getByIds(ids = []) {
      const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
      if (!wanted.size) return [];
      const found = (await load()).filter((it) => wanted.has(it.id));
      if (found.length !== wanted.size) {
        throw new AppError(`Część wybranych pozycji (${label.toLowerCase()}) nie istnieje, mogły zostać usunięte. Odśwież listę.`, 400);
      }
      return found;
    }
  };
}

function cleanGroup(g) {
  const value = typeof g === 'string' ? { dn: g } : (g || {});
  return { dn: String(value.dn || '').trim(), name: String(value.name || '').trim() };
}

module.exports = { createJsonStore, cleanGroup };
