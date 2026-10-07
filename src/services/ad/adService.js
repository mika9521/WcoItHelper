const { X509Certificate } = require('crypto');
const env = require('../../config/env');
const { Change, Attribute } = require('ldapts');
const { AppError } = require('../../utils/errors');
const { withUserBind, withAdaptiveBind } = require('./adClient');
const { normalizeObject } = require('./adMapper');

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

async function getObjectDetails(dn, authContext = null) {
  return withAdaptiveBind(authContext, async (client) => {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      attributes: ['*', 'member', 'managedBy', 'pwdLastSet', 'userAccountControl']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);
    return searchEntries[0];
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

async function createUser(payload, authContext = null) {
  const {
    ouDn,
    firstName,
    lastName,
    password,
    description,
    mustChangePasswordAtNextLogon,
    userCannotChangePassword,
    passwordNeverExpires,
    accountDisabled,
    accountExpiresMode,
    accountExpiresDate
  } = payload;
  const login = String(payload.login || '').trim();
  const groups = Array.isArray(payload.groups) ? payload.groups.filter(Boolean) : [];

  if (!login) throw new AppError('Brak loginu użytkownika', 400);
  if (!ouDn) throw new AppError('Nie wybrano docelowego OU', 400);
  if (!firstName || !lastName) throw new AppError('Imię i nazwisko są wymagane', 400);
  if (!password) throw new AppError('Hasło jest wymagane', 400);

  const displayName = `${firstName} ${lastName}`;
  // The AD object name (cn / RDN, the "Name" column in ADUC) is the login,
  // e.g. "kowalski.j", not the full name. Creating it under the login right
  // away (instead of creating "Jan Kowalski" and renaming it) also avoids a
  // collision when a namesake already exists in the same OU.
  const dn = `CN=${escapeDnValue(login)},${ouDn}`;

  return withAdaptiveBind(authContext, async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: login,
      givenName: firstName,
      sn: lastName,
      displayName,
      sAMAccountName: login,
      userPrincipalName: `${login}@${getDomainFromBaseDn()}`,
      ...(description ? { description } : {})
    });

    await client.modify(dn, toChange('replace', 'unicodePwd', encodePassword(password)));
    const UAC = {
      NORMAL_ACCOUNT: 0x0200,
      ACCOUNTDISABLE: 0x0002,
      PASSWD_CANT_CHANGE: 0x0040,
      DONT_EXPIRE_PASSWORD: 0x10000
    };
    let userAccountControl = UAC.NORMAL_ACCOUNT;
    if (Boolean(accountDisabled)) userAccountControl |= UAC.ACCOUNTDISABLE;
    if (Boolean(userCannotChangePassword)) userAccountControl |= UAC.PASSWD_CANT_CHANGE;
    if (Boolean(passwordNeverExpires)) userAccountControl |= UAC.DONT_EXPIRE_PASSWORD;

    await client.modify(dn, toChange('replace', 'userAccountControl', String(userAccountControl)));

    if (Boolean(mustChangePasswordAtNextLogon)) {
      await client.modify(dn, toChange('replace', 'pwdLastSet', '0'));
    }

    if (accountExpiresMode === 'date' && accountExpiresDate) {
      const fileTime = toWindowsFileTime(accountExpiresDate, true);
      if (!fileTime) throw new AppError('Nieprawidłowa data wygaśnięcia konta', 400);
      await client.modify(dn, toChange('replace', 'accountExpires', fileTime));
    } else {
      await client.modify(dn, toChange('replace', 'accountExpires', ACCOUNT_NEVER_EXPIRES));
    }

    const addedGroups = [];
    const failedGroups = [];
    for (const groupDn of groups) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.modify(groupDn, toChange('add', 'member', dn));
        addedGroups.push(groupDn);
      } catch (error) {
        failedGroups.push({ groupDn, message: error.message });
      }
    }

    return { dn, login, addedGroups, failedGroups };
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

    let nextUac = currentUac;
    const setFlag = (enabled, bit) => {
      if (typeof enabled !== 'boolean') return;
      nextUac = enabled ? (nextUac | bit) : (nextUac & ~bit);
    };
    setFlag(Boolean(accountDisabled), UAC.ACCOUNTDISABLE);
    setFlag(Boolean(userCannotChangePassword), UAC.PASSWD_CANT_CHANGE);
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
      await client.modify(objectDn, mod);
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
    const runCount = async (filter) => {
      const { searchEntries } = await client.search(env.ad.baseDn, {
        scope: 'sub',
        filter,
        attributes: ['dn'],
        paged: true,
        sizeLimit: 0
      });
      return searchEntries.length;
    };

    const blockedOu = escapeFilter(BLOCKED_ACCOUNTS_OU_DN);
    const activeUsersFilter = '(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))';
    const activeUsersWithoutBlockedOuFilter = `(&${activeUsersFilter}(!(distinguishedName=*,${blockedOu})))`;

    const [users, groups, computers, ous, activeUsers, activeUsersWithoutBlockedOu] = await Promise.all([
      runCount('(objectClass=user)'),
      runCount('(objectClass=group)'),
      runCount('(objectClass=computer)'),
      runCount('(objectClass=organizationalUnit)'),
      runCount(activeUsersFilter),
      runCount(activeUsersWithoutBlockedOuFilter)
    ]);

    return {
      users,
      groups,
      computers,
      ous,
      activeUsers,
      activeUsersWithoutBlockedOu,
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
  getObjectDetails,
  updateUserGroups,
  updateGroupMembers,
  copyGroupsFromReference,
  moveObject,
  createUser,
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
