// "User permissions" (applications, systems, ...): named entries mapped to
// one or more AD groups, and "file shares": a share path with a read-only
// (-r) and a read-write (-rw) AD group. Both are used by the new-user wizard.
const { AppError } = require('../../utils/errors');
const { createJsonStore, cleanGroup } = require('./jsonStore');
const { sanitizeAllowedTypes, isAllowedFor } = require('./accountTypes');

const byCategoryThenName = (list) => list.sort((a, b) => (a.category || '').localeCompare(b.category || '', 'pl') || a.name.localeCompare(b.name, 'pl'));

function requireName(input, max = 120) {
  const name = String(input.name || '').trim();
  if (!name) throw new AppError('Nazwa jest wymagana', 400);
  if (name.length > max) throw new AppError(`Nazwa może mieć maks. ${max} znaków`, 400);
  return name;
}

function sanitizePermission(input = {}) {
  const name = requireName(input);
  const seen = new Set();
  const groups = (Array.isArray(input.groups) ? input.groups : [])
    .map(cleanGroup)
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
    allowedTypes: sanitizeAllowedTypes(input.allowedTypes),
    groups
  };
}

function sanitizeShare(input = {}) {
  const name = requireName(input);
  const sharePath = String(input.path || '').trim();
  if (!sharePath) throw new AppError('Ścieżka udziału jest wymagana (np. \\\\serwer\\udzial)', 400);
  // A share may have only one of the groups (e.g. read-write only).
  const readGroup = cleanGroup(input.readGroup);
  const writeGroup = cleanGroup(input.writeGroup);
  if (!readGroup.dn && !writeGroup.dn) throw new AppError('Wybierz co najmniej jedną grupę: -r lub -rw', 400);
  if (readGroup.dn && writeGroup.dn && readGroup.dn.toLowerCase() === writeGroup.dn.toLowerCase()) {
    throw new AppError('Grupa odczytu i grupa odczytu/zapisu muszą być różne', 400);
  }
  return {
    name,
    description: String(input.description || '').trim().slice(0, 1000),
    path: sharePath.slice(0, 400),
    allowedTypes: sanitizeAllowedTypes(input.allowedTypes),
    readGroup: readGroup.dn ? readGroup : null,
    writeGroup: writeGroup.dn ? writeGroup : null
  };
}

const permissions = createJsonStore({
  file: 'permissions.json',
  key: 'permissions',
  label: 'Uprawnienie',
  sanitize: sanitizePermission,
  sort: byCategoryThenName
});

const shares = createJsonStore({
  file: 'shares.json',
  key: 'shares',
  label: 'Udział',
  sanitize: sanitizeShare,
  sort: (list) => list.sort((a, b) => a.name.localeCompare(b.name, 'pl'))
});

// [{ id, level: 'r' | 'rw' }] -> one group per share. Read-write grants only
// the -rw group (never both), read-only only the -r group.
async function resolveShareAccess(access = [], accountType = '') {
  const list = (Array.isArray(access) ? access : []).filter((a) => a && (a.level === 'r' || a.level === 'rw'));
  const byId = new Map(list.map((a) => [String(a.id), a.level]));
  const found = await shares.getByIds([...byId.keys()]);
  return found.map((share) => {
    const level = byId.get(share.id);
    const group = level === 'rw' ? share.writeGroup : share.readGroup;
    if (!group?.dn) throw new AppError(`Udział „${share.name}” nie ma grupy ${level === 'rw' ? '-rw (odczyt i zapis)' : '-r (tylko odczyt)'}`, 400);
    if (accountType && !isAllowedFor(share, accountType)) throw new AppError(`Udział „${share.name}” nie jest dostępny dla tego typu konta`, 400);
    return { share, level, group };
  });
}

async function getPermissionsForType(ids = [], accountType = '') {
  const found = await permissions.getByIds(ids);
  const blocked = found.filter((p) => accountType && !isAllowedFor(p, accountType));
  if (blocked.length) throw new AppError(`Uprawnienia niedostępne dla tego typu konta: ${blocked.map((p) => p.name).join(', ')}`, 400);
  return found;
}

module.exports = {
  listPermissions: permissions.list,
  createPermission: permissions.create,
  updatePermission: permissions.update,
  deletePermission: permissions.remove,
  getPermissionsByIds: getPermissionsForType,
  listShares: shares.list,
  createShare: shares.create,
  updateShare: shares.update,
  deleteShare: shares.remove,
  resolveShareAccess
};
