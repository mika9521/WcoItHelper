const env = require('../../config/env');
const { AppError } = require('../../utils/errors');
const { withServiceBind, withUserBind } = require('./adClient');
const { normalizeObject } = require('./adMapper');

const DEFAULT_ATTRS = [
  'cn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail', 'department', 'title',
  'whenCreated', 'lastLogonTimestamp', 'lastLogon', 'distinguishedName', 'description', 'memberOf', 'objectClass', 'objectCategory', 'sn', 'givenName', 'userAccountControl', 'name', 'ou'
];

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
    const identity = await getUserByLogin(login);
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
      memberOf: identity.memberOf
    };
  });
}

async function getUserByLogin(login) {
  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      filter: `(&(objectClass=user)(sAMAccountName=${escapeFilter(login)}))`,
      attributes: DEFAULT_ATTRS
    });
    return searchEntries.length ? normalizeObject(searchEntries[0]) : null;
  });
}

async function searchObjects(query, type) {
  const filters = {
    user: '(objectClass=user)',
    computer: '(objectClass=computer)',
    group: '(objectClass=group)',
    all: '(|(objectClass=user)(objectClass=computer)(objectClass=group))'
  };

  const typeFilter = filters[type] || filters.all;
  const term = escapeFilter(query);

  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(env.ad.baseDn, {
      scope: 'sub',
      sizeLimit: 50,
      filter: `(&${typeFilter}(|(cn=*${term}*)(sAMAccountName=*${term}*)(displayName=*${term}*)))`,
      attributes: DEFAULT_ATTRS
    });

    return searchEntries.map(normalizeObject);
  });
}

async function searchObjectsInOu(ouDn, type = 'all') {
  const filters = {
    user: '(objectClass=user)',
    computer: '(objectClass=computer)',
    group: '(objectClass=group)',
    all: '(|(objectClass=user)(objectClass=computer)(objectClass=group))'
  };
  const typeFilter = filters[type] || filters.all;
  const baseDn = ouDn || env.ad.baseDn;

  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope: 'sub',
      sizeLimit: 250,
      filter: `(&${typeFilter})`,
      attributes: DEFAULT_ATTRS
    });
    return searchEntries.map(normalizeObject);
  });
}

async function getObjectDetails(dn) {
  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      attributes: ['*', 'member', 'managedBy', 'pwdLastSet', 'userAccountControl']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);
    return searchEntries[0];
  });
}

async function updateUserGroups(userDn, addDns = [], removeDns = []) {
  return withServiceBind(async (client) => {
    for (const groupDn of addDns) {
      await client.modify(groupDn, [{ operation: 'add', modification: { member: userDn } }]);
    }
    for (const groupDn of removeDns) {
      await client.modify(groupDn, [{ operation: 'delete', modification: { member: userDn } }]);
    }
  });
}

async function copyGroupsFromReference(targetUserDn, referenceUserDn, selectedGroups) {
  const groups = selectedGroups.filter(Boolean);
  await updateUserGroups(targetUserDn, groups, []);
  return { targetUserDn, referenceUserDn, copied: groups.length };
}

async function moveObject(objectDn, newParentOuDn) {
  return withServiceBind(async (client) => {
    const rdn = objectDn.split(',')[0];
    await client.modifyDN(objectDn, rdn, true, newParentOuDn);
    return { moved: true };
  });
}

async function createUser(payload) {
  const {
    ouDn,
    firstName,
    lastName,
    login,
    password,
    description,
    mustChangePasswordAtNextLogon,
    userCannotChangePassword,
    passwordNeverExpires,
    accountDisabled,
    accountExpiresMode,
    accountExpiresDate
  } = payload;

  const cn = `${firstName} ${lastName}`;
  const dn = `CN=${cn},${ouDn}`;
  const domain = env.ad.baseDn
    .split(',')
    .map((p) => p.replace(/^DC=/i, ''))
    .join('.');

  return withServiceBind(async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn,
      givenName: firstName,
      sn: lastName,
      displayName: cn,
      sAMAccountName: login,
      userPrincipalName: `${login}@${domain}`,
      description
    });

    await client.modify(dn, [{ operation: 'replace', modification: { unicodePwd: encodePassword(password) } }]);
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

    await client.modify(dn, [{ operation: 'replace', modification: { userAccountControl: String(userAccountControl) } }]);

    if (Boolean(mustChangePasswordAtNextLogon)) {
      await client.modify(dn, [{ operation: 'replace', modification: { pwdLastSet: '0' } }]);
    }

    if (accountExpiresMode === 'date' && accountExpiresDate) {
      const fileTime = toWindowsFileTime(accountExpiresDate, true);
      if (!fileTime) throw new AppError('Nieprawidłowa data wygaśnięcia konta', 400);
      await client.modify(dn, [{ operation: 'replace', modification: { accountExpires: fileTime } }]);
    } else {
      await client.modify(dn, [{ operation: 'replace', modification: { accountExpires: '0' } }]);
    }

    return { dn, login };
  });
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


async function setAccountEnabled(objectDn, enabled) {
  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(objectDn, {
      scope: 'base',
      attributes: ['userAccountControl', 'objectClass']
    });
    if (!searchEntries.length) throw new AppError('Nie znaleziono obiektu', 404);

    const current = Number(searchEntries[0].userAccountControl || 512);
    const DISABLED_FLAG = 2;
    const next = enabled ? (current & ~DISABLED_FLAG) : (current | DISABLED_FLAG);

    await client.modify(objectDn, [{ operation: 'replace', modification: { userAccountControl: String(next) } }]);
    return { updated: true, enabled };
  });
}

function toWindowsFileTime(dateValue, endOfDay = false) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  const msSince1601 = date.getTime() + 11644473600000;
  return String(msSince1601 * 10000);
}

async function updateUserSettings(objectDn, payload = {}) {
  return withServiceBind(async (client) => {
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
      { operation: 'replace', modification: { userAccountControl: String(nextUac) } },
      { operation: 'replace', modification: { mail: mail || [] } },
      { operation: 'replace', modification: { profilePath: profilePath || [] } },
      { operation: 'replace', modification: { scriptPath: scriptPath || [] } },
      { operation: 'replace', modification: { homeDirectory: homeDirectory || [] } },
      { operation: 'replace', modification: { homeDrive: homeDrive || [] } }
    ];

    if (mustChangePasswordAtNextLogon === true) {
      modifications.push({ operation: 'replace', modification: { pwdLastSet: '0' } });
    } else if (mustChangePasswordAtNextLogon === false) {
      modifications.push({ operation: 'replace', modification: { pwdLastSet: '-1' } });
    }

    if (accountExpiresMode === 'date' && accountExpiresDate) {
      const fileTime = toWindowsFileTime(accountExpiresDate, true);
      if (!fileTime) throw new AppError('Nieprawidłowa data wygaśnięcia konta', 400);
      modifications.push({ operation: 'replace', modification: { accountExpires: fileTime } });
    } else if (accountExpiresMode === 'never') {
      modifications.push({ operation: 'replace', modification: { accountExpires: '0' } });
    }

    for (const mod of modifications) {
      await client.modify(objectDn, [mod]);
    }

    return { updated: true };
  });
}

async function listOuChildren(parentDn = env.ad.baseDn, onlyOu = false) {
  const filter = onlyOu
    ? '(|(objectClass=organizationalUnit)(objectClass=container))'
    : '(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=user)(objectClass=group)(objectClass=computer))';
  return withServiceBind(async (client) => {
    const { searchEntries } = await client.search(parentDn, {
      scope: 'one',
      filter,
      attributes: ['dn', 'cn', 'displayName', 'distinguishedName', 'objectClass', 'name', 'ou']
    });
    return searchEntries.map((entry) => normalizeObject(entry));
  });
}

async function getDashboardStats() {
  return withServiceBind(async (client) => {
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

    const [users, groups, computers, ous] = await Promise.all([
      runCount('(objectClass=user)'),
      runCount('(objectClass=group)'),
      runCount('(objectClass=computer)'),
      runCount('(objectClass=organizationalUnit)')
    ]);

    return { users, groups, computers, ous, total: users + groups + computers };
  });
}

async function createGroup(payload) {
  const { ouDn, name, samAccountName, description } = payload;
  const dn = `CN=${name},${ouDn}`;

  return withServiceBind(async (client) => {
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
  getObjectDetails,
  updateUserGroups,
  copyGroupsFromReference,
  moveObject,
  createUser,
  createGroup,
  setAccountEnabled,
  updateUserSettings,
  listOuChildren,
  getDashboardStats
};
