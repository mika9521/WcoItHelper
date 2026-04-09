function pickFirst(value) {
  if (Array.isArray(value)) return pickFirst(value.find((entry) => entry !== undefined && entry !== null));
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

function normalizeObject(entry) {
  const dn = pickFirst(entry.dn) || pickFirst(entry.distinguishedName) || '';
  const cn = pickFirst(entry.cn);
  const name = pickFirst(entry.name);
  const ou = pickFirst(entry.ou);
  const displayName = pickFirst(entry.displayName);
  const fallbackName = dn ? dn.split(',')[0].replace(/^[A-Z]+=/i, '').trim() : '';

  return {
    dn,
    cn,
    objectClass: entry.objectClass,
    objectCategory: entry.objectCategory,
    sAMAccountName: pickFirst(entry.sAMAccountName),
    name: name || cn || ou || fallbackName,
    ou,
    userPrincipalName: pickFirst(entry.userPrincipalName),
    displayName: displayName || name || cn || ou || fallbackName,
    mail: pickFirst(entry.mail),
    department: pickFirst(entry.department),
    title: pickFirst(entry.title),
    whenCreated: pickFirst(entry.whenCreated),
    lastLogonTimestamp: pickFirst(entry.lastLogonTimestamp),
    lastLogon: pickFirst(entry.lastLogon),
    sn: pickFirst(entry.sn),
    givenName: pickFirst(entry.givenName),
    memberOf: Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : [],
    distinguishedName: pickFirst(entry.distinguishedName) || dn,
    description: pickFirst(entry.description),
    userAccountControl: pickFirst(entry.userAccountControl),
    homeDirectory: pickFirst(entry.homeDirectory),
    homeDrive: pickFirst(entry.homeDrive),
    profilePath: pickFirst(entry.profilePath),
    scriptPath: pickFirst(entry.scriptPath),
    accountExpires: pickFirst(entry.accountExpires),
    pwdLastSet: pickFirst(entry.pwdLastSet)
  };
}

module.exports = { normalizeObject };
