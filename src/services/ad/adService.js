const { X509Certificate } = require('crypto');
const env = require('../../config/env');
const { Change, Attribute } = require('ldapts');
const { AppError } = require('../../utils/errors');
const { withUserBind, withAdaptiveBind } = require('./adClient');
const { normalizeObject } = require('./adMapper');
const { SdFlagsControl, getCannotChangePassword, setCannotChangePassword } = require('./securityDescriptor');

const DEFAULT_ATTRS = [
  'cn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail', 'department', 'title',
  'whenCreated', 'lastLogonTimestamp', 'lastLogon', 'distinguishedName', 'description', 'memberOf', 'objectClass', 'objectCategory', 'sn', 'givenName', 'userAccountControl', 'name', 'ou'
];
const BLOCKED_ACCOUNTS_OU_DN = 'OU=zablokowane_konta,DC=eskulap,DC=local';
// Some domain controllers reject accountExpires="0" for "never expires" with
// "Error in attribute conversion operation ... Code: 0x15"; the canonical
// Int64 max sentinel is universally accepted instead.
const ACCOUNT_NEVER_EXPIRES = '9223372036854775807';

function toChange(operation, attribute, values) {
  const list = Array.isArray(values) ? values : [values];
  return new Change({
    operation,
    modification: new Attribute({
      type: attribute,
      values: list
    })
  });
}

function buildUpn(login) {
  if (login.includes('@')) return login;
  const domainParts = env.ad.baseDn
    .split(',')
    .map((p) => p.trim().replace(/^DC=/i, ''));
  return `${login}@${domainParts.join('.')}`;
}

async function authenticate(login, password) {
  const userPrincipalName = buildUpn(login);

  return withUserBind(userPrincipalName, password, async () => {
    const identity = await getUserByLogin(login, {
      userPrincipalName,
      password
    });
    if (!identity) {
      throw new AppError('Nie znaleziono użytkownika w AD', 401);
    }

    const allowedByUser = env.ad.allowedUsers.includes(login.toLowerCase());
    const allowedByGroup = env.ad.allowedGroupDn && identity.memberOf.includes(env.ad.allowedGroupDn);

    if (!allowedByUser && !allowedByGroup) {
      throw new AppError('Brak uprawnień do portalu', 403);
    }

    return {
      login: identity.sAMAccountName,
      displayName: identity.displayName || identity.cn,
      dn: identity.dn,
      userPrincipalName,
      memberOf: identity.memberOf
    };
  });
}

async function getUserByLogin(login, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      filter: `(&(objectClass=user)(sAMAccountName=${escapeFilter(login)}))`,
      attributes: DEFAULT_ATTRS
    });
    return searchEntries.length ? normalizeObject(searchEntries[0]) : null;
  });
}

async function searchObjects(query, type, authContext = null) {
  const filters = {
    user: '(objectClass=user)',
    computer: '(objectClass=computer)',
    group: '(objectClass=group)',
    all: '(|(objectClass=user)(objectClass=computer)(objectClass=group))'
  };

  const typeFilter = filters[type] || filters.all;
  const pattern = toLdapPattern(query);
  const termFilter = pattern ? `(|(cn=${pattern})(sAMAccountName=${pattern})(displayName=${pattern}))` : '';

  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      sizeLimit: 50,
      filter: `(&${typeFilter}${termFilter})`,
      attributes: DEFAULT_ATTRS
    });

    return searchEntries.map(normalizeObject);
  });
}

async function searchObjectsInOu(ouDn, type = 'all', authContext = null) {
  const filters = {
    user: '(objectClass=user)',
    computer: '(objectClass=computer)',
    group: '(objectClass=group)',
    all: '(|(objectClass=user)(objectClass=computer)(objectClass=group))'
  };
  const typeFilter = filters[type] || filters.all;
  const baseDn = ouDn || env.ad.baseDn;

  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope: 'sub',
      sizeLimit: 250,
      filter: `(&${typeFilter})`,
      attributes: DEFAULT_ATTRS
    });
    return searchEntries.map(normalizeObject);
  });
}

const SEARCH_FIELDS = {
  any: ['cn', 'sAMAccountName', 'displayName', 'givenName', 'sn', 'mail'],
  sAMAccountName: ['sAMAccountName'],
  displayName: ['displayName', 'cn'],
  givenName: ['givenName'],
  sn: ['sn'],
  mail: ['mail', 'userPrincipalName'],
  description: ['description'],
  department: ['department'],
  title: ['title']
};

const SEARCH_TYPE_FILTERS = {
  // Computer accounts also carry objectClass=user, hence objectCategory.
  user: '(&(objectCategory=person)(objectClass=user))',
  computer: '(objectClass=computer)',
  group: '(objectClass=group)',
  all: '(|(objectClass=user)(objectClass=computer)(objectClass=group))'
};

const SEARCH_LIMITS = [50, 100, 250, 500];

// SQL-LIKE style pattern -> LDAP substring value. "%" (or "*") is the
// wildcard; without one the term is matched anywhere ("contains"), so
// "kow" == "%kow%", "kow%" = starts with, "%ski" = ends with.
function toLdapPattern(term) {
  const raw = String(term || '').trim();
  if (!raw) return '';
  if (!/[%*]/.test(raw)) return `*${escapeFilter(raw)}*`;
  const pattern = raw
    .split(/[%*]/)
    .map((part) => escapeFilter(part))
    .join('*')
    .replace(/\*{2,}/g, '*');
  return pattern === '*' ? '' : pattern;
}

function daysAgoFileTime(days) {
  return String((Date.now() - days * 86400000 + 11644473600000) * 10000);
}

async function advancedSearch(options = {}, authContext = null) {
  const type = SEARCH_TYPE_FILTERS[options.type] ? options.type : 'all';
  const fields = SEARCH_FIELDS[options.field] || SEARCH_FIELDS.any;
  const pattern = toLdapPattern(options.q);
  const limit = SEARCH_LIMITS.includes(Number(options.limit)) ? Number(options.limit) : 50;
  const baseDn = options.ouDn || env.ad.baseDn;
  const scope = options.subtree === false ? 'one' : 'sub';
  const days = Math.max(1, Math.min(Number(options.days) || 90, 36500));

  const parts = [SEARCH_TYPE_FILTERS[type]];
  if (pattern) {
    parts.push(`(|${fields.map((attr) => `(${attr}=${pattern})`).join('')})`);
  }
  if (options.status === 'enabled') parts.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');
  if (options.status === 'disabled') parts.push('(userAccountControl:1.2.840.113556.1.4.803:=2)');
  // lastLogonTimestamp is replicated to every DC (with up to ~14 days lag),
  // which makes it the attribute AD itself recommends for stale-account queries.
  if (options.logon === 'older') parts.push(`(|(!(lastLogonTimestamp=*))(lastLogonTimestamp<=${daysAgoFileTime(days)}))`);
  if (options.logon === 'within') parts.push(`(lastLogonTimestamp>=${daysAgoFileTime(days)})`);
  if (options.logon === 'never') parts.push('(!(lastLogonTimestamp=*))');

  const filter = `(&${parts.join('')})`;

  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope,
      sizeLimit: limit + 1,
      filter,
      attributes: DEFAULT_ATTRS
    });
    const rows = searchEntries.slice(0, limit).map(normalizeObject);
    return { rows, truncated: searchEntries.length > limit, limit, filter };
  });
}

function toGeneralizedTime(date) {
  return `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}.0Z`;
}

// Inactive accounts: enabled users or computers whose replicated
// lastLogonTimestamp is older than `days` (or missing). Objects created
// within that period are skipped, as they could not have been inactive
// for that long yet. Paged, so it is not capped like the quick search.
async function staleAccounts(kind = 'user', days = 730, options = {}, authContext = null) {
  const typeFilter = kind === 'computer' ? SEARCH_TYPE_FILTERS.computer : SEARCH_TYPE_FILTERS.user;
  const threshold = new Date(Date.now() - days * 86400000);
  const parts = [
    typeFilter,
    `(|(!(lastLogonTimestamp=*))(lastLogonTimestamp<=${daysAgoFileTime(days)}))`,
    `(whenCreated<=${toGeneralizedTime(threshold)})`
  ];
  if (!options.includeDisabled) parts.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');

  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(options.ouDn || env.ad.baseDn, {
      scope: 'sub',
      filter: `(&${parts.join('')})`,
      attributes: [...DEFAULT_ATTRS, 'operatingSystem', 'operatingSystemVersion', 'pwdLastSet', 'dNSHostName'],
      paged: true,
      sizeLimit: 0
    });
    return searchEntries.map(normalizeObject);
  });
}

async function getObjectDetails(dn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      attributes: ['*', 'member', 'managedBy', 'pwdLastSet', 'userAccountControl']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);
    const entry = searchEntries[0];
    const classes = [].concat(entry.objectClass || []).map((c) => String(c).toLowerCase());
    if (classes.includes('user') && !classes.includes('computer')) {
      try {
        entry.portalUserCannotChangePassword = getCannotChangePassword(await readSecurityDescriptor(client, dn));
      } catch {
        // No right to read the DACL: the settings tab falls back to UAC.
      }
    }
    return entry;
  });
}

async function updateUserGroups(userDn, addDns = [], removeDns = [], authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    for (const groupDn of addDns) {
      await client.modify(groupDn, toChange('add', 'member', userDn));
    }
    for (const groupDn of removeDns) {
      await client.modify(groupDn, toChange('delete', 'member', userDn));
    }
  });
}

async function updateGroupMembers(groupDn, addMemberDns = [], removeMemberDns = [], authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    for (const memberDn of addMemberDns) {
      await client.modify(groupDn, toChange('add', 'member', memberDn));
    }
    for (const memberDn of removeMemberDns) {
      await client.modify(groupDn, toChange('delete', 'member', memberDn));
    }
  });
}

async function copyGroupsFromReference(targetUserDn, referenceUserDn, selectedGroups, authContext = null) {
  const groups = selectedGroups.filter(Boolean);
  await updateUserGroups(targetUserDn, groups, [], authContext);
  return { targetUserDn, referenceUserDn, copied: groups.length };
}

async function moveObject(objectDn, newParentOuDn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const rdn = objectDn.split(',')[0];
    await client.modifyDN(objectDn, `${rdn},${newParentOuDn}`);
    return { moved: true };
  });
}

// Passwords (unicodePwd) can only be written over an encrypted connection;
// over plain LDAP AD answers "0000001F: SvcErr ... problem 5003
// (WILL_NOT_PERFORM)".
function isConnectionEncrypted() {
  const url = String(env.ad.url || '').toLowerCase();
  return url.startsWith('ldaps://') || (url.startsWith('ldap://') && env.ad.tlsEnabled);
}

// Translates the most common AD error codes into an actionable message.
function explainAdError(error, context = '') {
  const msg = String(error?.message || error || '');
  const prefix = context ? `${context}: ` : '';
  if (/0000001F/i.test(msg) && /5003/.test(msg)) {
    return new AppError(`${prefix}AD odmówił operacji (WILL_NOT_PERFORM). Hasło można ustawić tylko przez połączenie szyfrowane: użyj LDAPS (AD_PROTOCOL=ldaps, port 636) albo StartTLS (AD_TLS_ENABLED=true). Szczegóły: ${msg}`, 400);
  }
  if (/0000052D/i.test(msg)) {
    return new AppError(`${prefix}Hasło nie spełnia zasad domeny (długość, złożoność lub historia haseł). Szczegóły: ${msg}`, 400);
  }
  if (/00000005|INSUFF_ACCESS_RIGHTS/i.test(msg)) {
    return new AppError(`${prefix}Brak uprawnień konta używanego przez portal do tej operacji. Szczegóły: ${msg}`, 403);
  }
  if (/00002071|ENTRY_EXISTS|already exists/i.test(msg)) {
    return new AppError(`${prefix}Obiekt o tej nazwie już istnieje w wybranym OU. Szczegóły: ${msg}`, 409);
  }
  if (/0000208F|NAME_ERROR|00000524/i.test(msg)) {
    return new AppError(`${prefix}Login lub nazwa jest już używana w domenie. Szczegóły: ${msg}`, 409);
  }
  return error instanceof AppError ? error : new AppError(`${prefix}${msg}`, error?.status || 500);
}

async function readSecurityDescriptor(client, dn) {
  const { searchEntries } = await client.search(dn, {
    scope: 'base',
    attributes: ['nTSecurityDescriptor'],
    explicitBufferAttributes: ['nTSecurityDescriptor']
  }, new SdFlagsControl(4));
  const raw = searchEntries[0]?.nTSecurityDescriptor;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new AppError('Nie udało się odczytać uprawnień (nTSecurityDescriptor) obiektu', 500);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function applyCannotChangePassword(client, dn, enabled) {
  const current = await readSecurityDescriptor(client, dn);
  if (getCannotChangePassword(current) === Boolean(enabled)) return;
  const updated = setCannotChangePassword(current, Boolean(enabled));
  await client.modify(dn, toChange('replace', 'nTSecurityDescriptor', updated), new SdFlagsControl(4));
}

async function readCannotChangePassword(dn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => getCannotChangePassword(await readSecurityDescriptor(client, dn)));
}

async function createUser(payload, authContext = null) {
  const {
    ouDn,
    firstName,
    lastName,
    password,
    description,
    accountExpiresMode,
    accountExpiresDate
  } = payload;
  const mustChangePasswordAtNextLogon = payload.mustChangePasswordAtNextLogon === true;
  const userCannotChangePassword = payload.userCannotChangePassword === true;
  const passwordNeverExpires = payload.passwordNeverExpires === true;
  const accountDisabled = payload.accountDisabled === true;
  const login = String(payload.login || '').trim();
  const groups = Array.isArray(payload.groups) ? payload.groups.filter(Boolean) : [];

  const isService = payload.accountType === 'service';
  if (!login) throw new AppError('Brak loginu użytkownika', 400);
  if (!ouDn) throw new AppError('Nie wybrano docelowego OU', 400);
  if (!isService && (!firstName || !lastName)) throw new AppError('Imię i nazwisko są wymagane', 400);
  if (isService && !String(payload.displayName || '').trim()) throw new AppError('Nazwa konta serwisowego jest wymagana', 400);
  if (!password) throw new AppError('Hasło jest wymagane', 400);
  if (!isConnectionEncrypted()) {
    throw new AppError('Portal łączy się z AD bez szyfrowania, a AD pozwala ustawić hasło tylko przez LDAPS lub StartTLS. Ustaw AD_PROTOCOL=ldaps (port 636) albo AD_TLS_ENABLED=true i uruchom portal ponownie. Konto nie zostało utworzone.', 400);
  }

  let accountExpires = ACCOUNT_NEVER_EXPIRES;
  if (accountExpiresMode === 'date' && accountExpiresDate) {
    accountExpires = toWindowsFileTime(accountExpiresDate, true);
    if (!accountExpires) throw new AppError('Nieprawidłowa data wygaśnięcia konta', 400);
  }

  const UAC = {
    NORMAL_ACCOUNT: 0x0200,
    ACCOUNTDISABLE: 0x0002,
    DONT_EXPIRE_PASSWORD: 0x10000
  };
  let userAccountControl = UAC.NORMAL_ACCOUNT;
  if (accountDisabled) userAccountControl |= UAC.ACCOUNTDISABLE;
  if (passwordNeverExpires) userAccountControl |= UAC.DONT_EXPIRE_PASSWORD;

  const displayName = isService ? String(payload.displayName).trim() : `${firstName} ${lastName}`;
  // The AD object name (cn / RDN, the "Name" column in ADUC) is the login,
  // e.g. "kowalski.j", not the full name. Creating it under the login right
  // away (instead of creating "Jan Kowalski" and renaming it) also avoids a
  // collision when a namesake already exists in the same OU.
  const dn = `CN=${escapeDnValue(login)},${ouDn}`;

  const attr = (type, values) => new Attribute({ type, values: Array.isArray(values) ? values : [values] });
  // Password, account flags and expiry go into the add itself, so the
  // account is either created complete or not at all (no half-created,
  // disabled object left behind when one of the later steps fails).
  const attributes = [
    attr('objectClass', ['top', 'person', 'organizationalPerson', 'user']),
    attr('cn', login),
    attr('displayName', displayName),
    attr('sAMAccountName', login),
    attr('userPrincipalName', `${login}@${getDomainFromBaseDn()}`),
    attr('unicodePwd', encodePassword(password)),
    attr('userAccountControl', String(userAccountControl)),
    attr('accountExpires', accountExpires)
  ];
  if (firstName) attributes.push(attr('givenName', firstName));
  if (lastName) attributes.push(attr('sn', lastName));
  if (description) attributes.push(attr('description', description));

  return withAdaptiveBind(authContext, async (client) => {
    try {
      await client.add(dn, attributes);
    } catch (error) {
      throw explainAdError(error, 'Nie utworzono konta');
    }

    // Remaining account settings; if any of them fails the account is
    // removed again so the operation can simply be retried.
    try {
      // 0 = must change at next logon; -1 = "password set now".
      await client.modify(dn, toChange('replace', 'pwdLastSet', mustChangePasswordAtNextLogon ? '0' : '-1'));
      if (userCannotChangePassword) await applyCannotChangePassword(client, dn, true);
    } catch (error) {
      let rollback = 'konto zostało usunięte, można spróbować ponownie';
      try {
        await client.del(dn);
      } catch (delError) {
        rollback = `nie udało się usunąć częściowo utworzonego konta (${delError.message}), usuń je ręcznie`;
      }
      throw explainAdError(error, `Błąd ustawiania opcji konta (${rollback})`);
    }

    const addedGroups = [];
    const failedGroups = [];
    for (const groupDn of groups) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.modify(groupDn, toChange('add', 'member', dn));
        addedGroups.push(groupDn);
      } catch (error) {
        failedGroups.push({ groupDn, message: explainAdError(error).message });
      }
    }

    return {
      dn,
      login,
      addedGroups,
      failedGroups,
      settings: { mustChangePasswordAtNextLogon, userCannotChangePassword, passwordNeverExpires, accountDisabled }
    };
  });
}

function getDomainFromBaseDn() {
  return String(env.ad.baseDn || '')
    .split(',')
    .map((p) => p.trim().replace(/^DC=/i, ''))
    .filter(Boolean)
    .join('.');
}

// RFC 4514 escaping for a single RDN attribute value.
function escapeDnValue(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([,+"<>;=])/g, '\\$1')
    .replace(/^([ #])/, '\\$1')
    .replace(/ $/, '\\ ');
}

function encodePassword(password) {
  return Buffer.from(`"${password}"`, 'utf16le');
}

function escapeFilter(value = '') {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

const POLISH_CHAR_MAP = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'a', Ć: 'c', Ę: 'e', Ł: 'l', Ń: 'n', Ó: 'o', Ś: 's', Ź: 'z', Ż: 'z'
};

function transliteratePolish(text) {
  return String(text || '').split('').map((ch) => POLISH_CHAR_MAP[ch] ?? ch).join('');
}

function sanitizeLoginPart(text) {
  return transliteratePolish(text).toLowerCase().replace(/[^a-z]/g, '');
}

async function isSamAccountNameTaken(login, authContext = null) {
  if (!login) return true;
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      sizeLimit: 1,
      filter: `(sAMAccountName=${escapeFilter(login)})`,
      attributes: ['dn']
    });
    return searchEntries.length > 0;
  });
}

async function suggestLogin(firstName, lastName, authContext = null) {
  const last = sanitizeLoginPart(lastName);
  const first = sanitizeLoginPart(firstName);
  if (!last || !first) return { login: '', available: false };

  const candidates = [];
  for (let len = 1; len <= first.length; len += 1) {
    candidates.push(`${last}.${first.slice(0, len)}`);
  }
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    candidates.push(`${last}.${first}${suffix}`);
  }

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await isSamAccountNameTaken(candidate, authContext);
    if (!taken) return { login: candidate, available: true };
  }
  return { login: candidates[candidates.length - 1] || '', available: false };
}

async function setAccountEnabled(objectDn, enabled, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(objectDn, {
      scope: 'base',
      attributes: ['userAccountControl', 'objectClass']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);

    const current = Number(searchEntries[0].userAccountControl || 512);
    const DISABLED_FLAG = 2;
    const next = enabled ? (current & ~DISABLED_FLAG) : (current | DISABLED_FLAG);

    await client.modify(objectDn, toChange('replace', 'userAccountControl', String(next)));
    return { updated: true, enabled };
  });
}

async function softDeleteAccount(objectDn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(objectDn, {
      scope: 'base',
      attributes: ['userAccountControl', 'memberOf']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);

    // Snapshot of group membership taken before anything changes, so the
    // audit log keeps what the account belonged to. (The primary group,
    // usually Domain Users, is not listed in memberOf and stays as is.)
    const rawMemberOf = searchEntries[0].memberOf;
    const groupsBefore = (Array.isArray(rawMemberOf) ? rawMemberOf : rawMemberOf ? [rawMemberOf] : []).map(String);

    const current = Number(searchEntries[0].userAccountControl || 512);
    const next = current | 0x0002;
    await client.modify(objectDn, toChange('replace', 'userAccountControl', String(next)));

    const removedGroups = [];
    const failedGroups = [];
    for (const groupDn of groupsBefore) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.modify(groupDn, toChange('delete', 'member', objectDn));
        removedGroups.push(groupDn);
      } catch (error) {
        failedGroups.push({ groupDn, message: error.message });
      }
    }

    const rdn = objectDn.split(',')[0];
    await client.modifyDN(objectDn, `${rdn},${BLOCKED_ACCOUNTS_OU_DN}`);

    return {
      updated: true,
      movedTo: BLOCKED_ACCOUNTS_OU_DN,
      newDn: `${rdn},${BLOCKED_ACCOUNTS_OU_DN}`,
      groupsBefore,
      removedGroups,
      failedGroups
    };
  });
}

async function unlockAccount(objectDn, targetOuDn, authContext = null) {
  if (!targetOuDn) throw new AppError('Nie wybrano docelowego OU', 400);
  await setAccountEnabled(objectDn, true, authContext);
  const rdn = objectDn.split(',')[0];
  await moveObject(objectDn, targetOuDn, authContext);
  return { updated: true, movedTo: targetOuDn, dn: `${rdn},${targetOuDn}` };
}

function toWindowsFileTime(dateValue, endOfDay = false) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  const msSince1601 = date.getTime() + 11644473600000;
  return String(msSince1601 * 10000);
}

async function updateUserSettings(objectDn, payload = {}, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(objectDn, {
      scope: 'base',
      attributes: ['userAccountControl']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);

    const currentUac = Number(searchEntries[0].userAccountControl || 512);
    const {
      mail,
      mustChangePasswordAtNextLogon,
      userCannotChangePassword,
      passwordNeverExpires,
      accountDisabled,
      smartcardRequired,
      accountExpiresMode,
      accountExpiresDate,
      profilePath,
      scriptPath,
      homeDirectory,
      homeDrive
    } = payload;

    const UAC = {
      ACCOUNTDISABLE: 0x0002,
      PASSWD_CANT_CHANGE: 0x0040,
      DONT_EXPIRE_PASSWORD: 0x10000,
      SMARTCARD_REQUIRED: 0x40000
    };
    // PASSWD_CANT_CHANGE in userAccountControl is ignored by AD; the real
    // setting lives in the DACL (applied below), so keep the bit cleared.

    let nextUac = currentUac;
    const setFlag = (enabled, bit) => {
      if (typeof enabled !== 'boolean') return;
      nextUac = enabled ? (nextUac | bit) : (nextUac & ~bit);
    };
    setFlag(Boolean(accountDisabled), UAC.ACCOUNTDISABLE);
    nextUac &= ~UAC.PASSWD_CANT_CHANGE;
    setFlag(Boolean(passwordNeverExpires), UAC.DONT_EXPIRE_PASSWORD);
    setFlag(Boolean(smartcardRequired), UAC.SMARTCARD_REQUIRED);

    const modifications = [
      toChange('replace', 'userAccountControl', String(nextUac)),
      toChange('replace', 'mail', mail || []),
      toChange('replace', 'profilePath', profilePath || []),
      toChange('replace', 'scriptPath', scriptPath || []),
      toChange('replace', 'homeDirectory', homeDirectory || []),
      toChange('replace', 'homeDrive', homeDrive || [])
    ];

    if (mustChangePasswordAtNextLogon === true) {
      modifications.push(toChange('replace', 'pwdLastSet', '0'));
    } else if (mustChangePasswordAtNextLogon === false) {
      modifications.push(toChange('replace', 'pwdLastSet', '-1'));
    }

    if (accountExpiresMode === 'date' && accountExpiresDate) {
      const fileTime = toWindowsFileTime(accountExpiresDate, true);
      if (!fileTime) throw new AppError('Nieprawidłowa data wygaśnięcia konta', 400);
      modifications.push(toChange('replace', 'accountExpires', fileTime));
    } else if (accountExpiresMode === 'never') {
      modifications.push(toChange('replace', 'accountExpires', ACCOUNT_NEVER_EXPIRES));
    }

    for (const mod of modifications) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.modify(objectDn, mod);
      } catch (error) {
        throw explainAdError(error, `Nie zapisano pola ${mod.modification.type}`);
      }
    }

    if (typeof userCannotChangePassword === 'boolean') {
      try {
        await applyCannotChangePassword(client, objectDn, userCannotChangePassword);
      } catch (error) {
        throw explainAdError(error, 'Nie zapisano opcji „Użytkownik nie może zmienić hasła”');
      }
    }

    return { updated: true };
  });
}

async function getBitlockerKeys(computerDn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(computerDn, {
      scope: 'one',
      filter: '(objectClass=msFVE-RecoveryInformation)',
      attributes: ['msFVE-RecoveryPassword', 'msFVE-RecoveryGuid', 'name', 'whenCreated', 'distinguishedName']
    });

    return searchEntries.map((entry) => {
      const pick = (value) => (Array.isArray(value) ? value[0] : value);
      const guidRaw = pick(entry['msFVE-RecoveryGuid']);
      return {
        dn: entry.dn || pick(entry.distinguishedName) || '',
        name: pick(entry.name) || '',
        recoveryPassword: pick(entry['msFVE-RecoveryPassword']) || '',
        recoveryGuid: Buffer.isBuffer(guidRaw) ? guidRaw.toString('hex') : String(guidRaw || ''),
        whenCreated: pick(entry.whenCreated) || ''
      };
    });
  });
}

function extractCertificateCn(subject) {
  const match = String(subject || '').match(/^CN=(.+)$/m);
  return match ? match[1] : '';
}

function parseCertificate(buffer, index) {
  try {
    const cert = new X509Certificate(buffer);
    const validTo = new Date(cert.validTo);
    const validFrom = new Date(cert.validFrom);
    const now = Date.now();
    return {
      index,
      subject: cert.subject,
      subjectCn: extractCertificateCn(cert.subject),
      issuer: cert.issuer,
      issuerCn: extractCertificateCn(cert.issuer),
      subjectAltName: cert.subjectAltName || '',
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      expired: validTo.getTime() < now,
      notYetValid: validFrom.getTime() > now,
      serialNumber: cert.serialNumber,
      thumbprint: String(cert.fingerprint || '').replace(/:/g, ''),
      fingerprint256: cert.fingerprint256
    };
  } catch (error) {
    return {
      index,
      subject: 'Nie udało się odczytać certyfikatu',
      subjectCn: '',
      issuer: '',
      issuerCn: '',
      subjectAltName: '',
      validFrom: '',
      validTo: '',
      expired: false,
      notYetValid: false,
      serialNumber: '',
      thumbprint: '',
      fingerprint256: require('crypto').createHash('sha256').update(buffer).digest('hex'),
      parseError: error.message
    };
  }
}

// userCertificate holds binary DER values; without explicitBufferAttributes
// ldapts decodes them as UTF-8 strings, which corrupts them.
async function readUserCertificateBuffers(client, userDn) {
  const { searchEntries } = await client.search(userDn, {
    scope: 'base',
    attributes: ['userCertificate'],
    explicitBufferAttributes: ['userCertificate']
  });
  if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);
  const raw = searchEntries[0].userCertificate;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)));
}

async function getUserCertificates(userDn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const buffers = await readUserCertificateBuffers(client, userDn);
    return buffers.map((buffer, index) => parseCertificate(buffer, index));
  });
}

// Removes one certificate (matched by its SHA-256 fingerprint) from the
// account's userCertificate attribute. This does not revoke it at the CA.
async function deleteUserCertificate(userDn, fingerprint256, authContext = null) {
  if (!fingerprint256) throw new AppError('Brak identyfikatora certyfikatu do usunięcia', 400);
  return withAdaptiveBind(authContext, async (client) => {
    const buffers = await readUserCertificateBuffers(client, userDn);
    const index = buffers.findIndex((buffer, i) => parseCertificate(buffer, i).fingerprint256 === fingerprint256);
    if (index === -1) throw new AppError('Nie znaleziono certyfikatu na koncie (mógł zostać już usunięty)', 404);
    const certificate = parseCertificate(buffers[index], index);
    await client.modify(userDn, toChange('delete', 'userCertificate', buffers[index]));
    return { deleted: true, certificate };
  });
}

async function listOuChildren(parentDn = env.ad.baseDn, onlyOu = false, authContext = null) {
  const filter = onlyOu
    ? '(|(objectClass=organizationalUnit)(objectClass=container))'
    : '(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=user)(objectClass=group)(objectClass=computer))';
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(parentDn, {
      scope: 'one',
      filter,
      attributes: ['dn', 'cn', 'displayName', 'distinguishedName', 'objectClass', 'name', 'ou']
    });
    return searchEntries.map((entry) => normalizeObject(entry));
  });
}

async function searchOus(query, authContext = null) {
  const term = escapeFilter(String(query || '').trim());
  if (!term) return [];
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      sizeLimit: 100,
      filter: `(&(|(objectClass=organizationalUnit)(objectClass=container))(|(ou=*${term}*)(name=*${term}*)(description=*${term}*)))`,
      attributes: ['dn', 'cn', 'distinguishedName', 'objectClass', 'name', 'ou', 'description']
    });
    return searchEntries.map((entry) => normalizeObject(entry));
  });
}

async function getDashboardStats(authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const runSearch = async (filter) => {
      const { searchEntries } = await client.search(env.ad.baseDn, {
        scope: 'sub',
        filter,
        attributes: ['dn'],
        paged: true,
        sizeLimit: 0
      });
      return searchEntries;
    };
    const runCount = async (filter) => (await runSearch(filter)).length;
    // AD does not support substring filters on distinguishedName, so the
    // "outside OU zablokowane_konta" part is applied to the returned DNs.
    const blockedSuffix = `,${BLOCKED_ACCOUNTS_OU_DN}`.toLowerCase();
    const countOutsideBlockedOu = async (filter) => (await runSearch(filter))
      .filter((e) => !String(e.dn || '').toLowerCase().endsWith(blockedSuffix)).length;

    const enabled = '(!(userAccountControl:1.2.840.113556.1.4.803:=2))';
    const staleFilter = (days) => `(|(!(lastLogonTimestamp=*))(lastLogonTimestamp<=${daysAgoFileTime(days)}))(whenCreated<=${toGeneralizedTime(new Date(Date.now() - days * 86400000))})`;
    const usersFilter = SEARCH_TYPE_FILTERS.user;
    const activeUsersFilter = `(&${usersFilter}${enabled})`;

    const [users, groups, computers, ous, activeUsers, activeUsersWithoutBlockedOu, staleUsers2y, staleComputers1y] = await Promise.all([
      runCount(usersFilter),
      runCount('(objectClass=group)'),
      runCount('(objectClass=computer)'),
      runCount('(objectClass=organizationalUnit)'),
      runCount(activeUsersFilter),
      countOutsideBlockedOu(activeUsersFilter),
      countOutsideBlockedOu(`(&${usersFilter}${enabled}${staleFilter(730)})`),
      runCount(`(&(objectClass=computer)${enabled}${staleFilter(365)})`)
    ]);

    return {
      users,
      groups,
      computers,
      ous,
      activeUsers,
      activeUsersWithoutBlockedOu,
      staleUsers2y,
      staleComputers1y,
      total: users + groups + computers
    };
  });
}

async function createGroup(payload, authContext = null) {
  const { ouDn, name, samAccountName, description } = payload;
  const dn = `CN=${name},${ouDn}`;

  return withAdaptiveBind(authContext, async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'group'],
      cn: name,
      sAMAccountName: samAccountName,
      description,
      groupType: '-2147483646'
    });

    return { dn, name, samAccountName };
  });
}

module.exports = {
  authenticate,
  searchObjects,
  searchObjectsInOu,
  advancedSearch,
  staleAccounts,
  getObjectDetails,
  updateUserGroups,
  updateGroupMembers,
  copyGroupsFromReference,
  moveObject,
  createUser,
  readCannotChangePassword,
  createGroup,
  setAccountEnabled,
  softDeleteAccount,
  unlockAccount,
  updateUserSettings,
  listOuChildren,
  searchOus,
  getDomainFromBaseDn,
  getDashboardStats,
  getBitlockerKeys,
  isSamAccountNameTaken,
  suggestLogin,
  getUserCertificates,
  deleteUserCertificate
};
