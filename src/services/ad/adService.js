const env = require('../../config/env');
const { AppError } = require('../../utils/errors');
const { withServiceBind, withUserBind } = require('./adClient');
const { normalizeObject } = require('./adMapper');

const DEFAULT_ATTRS = [
  'cn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail', 'department', 'title',
  'whenCreated', 'lastLogonTimestamp', 'distinguishedName', 'description', 'memberOf', 'objectClass', 'objectCategory'
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
    description
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
    await client.modify(dn, [{ operation: 'replace', modification: { userAccountControl: '512' } }]);

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

module.exports = {
  authenticate,
  searchObjects,
  getObjectDetails,
  updateUserGroups,
  copyGroupsFromReference,
  moveObject,
  createUser
};
