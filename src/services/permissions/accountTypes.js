// Account types offered by the new-user wizard. Permissions and file shares
// can be limited to selected types (empty list = available for all types).
const ACCOUNT_TYPES = [
  { id: 'eskulap-domain', label: 'Użytkownik domeny Eskulap' },
  { id: 'service', label: 'Konto serwisowe', loginPrefix: 'svc_' }
];

const ACCOUNT_TYPE_IDS = ACCOUNT_TYPES.map((t) => t.id);

function sanitizeAllowedTypes(value) {
  const list = Array.isArray(value) ? value.map(String).filter((t) => ACCOUNT_TYPE_IDS.includes(t)) : [];
  // All types selected is stored as "no restriction".
  return list.length === ACCOUNT_TYPE_IDS.length ? [] : [...new Set(list)];
}

function isAllowedFor(item, type) {
  return !item.allowedTypes || !item.allowedTypes.length || item.allowedTypes.includes(type);
}

module.exports = { ACCOUNT_TYPES, ACCOUNT_TYPE_IDS, sanitizeAllowedTypes, isAllowedFor };
