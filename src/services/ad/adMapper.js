function normalizeObject(entry) {
  return {
    dn: entry.dn,
    cn: entry.cn,
    objectClass: entry.objectClass,
    objectCategory: entry.objectCategory,
    sAMAccountName: entry.sAMAccountName,
    userPrincipalName: entry.userPrincipalName,
    displayName: entry.displayName,
    mail: entry.mail,
    department: entry.department,
    title: entry.title,
    whenCreated: entry.whenCreated,
    lastLogonTimestamp: entry.lastLogonTimestamp,
    sn: entry.sn,
    givenName: entry.givenName,
    memberOf: Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : [],
    distinguishedName: entry.distinguishedName,
    description: entry.description,
    userAccountControl: entry.userAccountControl
  };
}

module.exports = { normalizeObject };
