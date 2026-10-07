const express = require('express');
const {
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
  getDashboardStats,
  getBitlockerKeys,
  isSamAccountNameTaken,
  suggestLogin,
  getUserCertificates,
  deleteUserCertificate
} = require('../services/ad/adService');
const { staleLogons } = require('../services/reports/reportService');
const {
  listPermissions,
  createPermission,
  updatePermission,
  deletePermission,
  getPermissionsByIds,
  listShares,
  createShare,
  updateShare,
  deleteShare,
  resolveShareAccess
} = require('../services/permissions/permissionService');
const { getSettings, updateSettings } = require('../services/permissions/settingsService');
const { ACCOUNT_TYPE_IDS } = require('../services/permissions/accountTypes');

const VIEW_ACTIONS = ['object_view', 'user_certificates_view', 'bitlocker_keys_view'];
const {
  logEvent,
  readEvents,
  getObjectEvents,
  getRecentLoginEvents,
  queryEvents
} = require('../services/audit/auditLogService');

const router = express.Router();

function adAuthFromRequest(req) {
  return req.session?.user?.adAuth || null;
}

function actorFromRequest(req) {
  return {
    actorLogin: req.session?.user?.login || '',
    actorDisplayName: req.session?.user?.displayName || '',
    actorDn: req.session?.user?.dn || '',
    sourceIp: req.ip,
    userAgent: req.get('user-agent')
  };
}

async function audit(req, payload = {}) {
  await logEvent({
    ...actorFromRequest(req),
    ...payload
  });
}

router.get('/api/search', async (req, res) => {
  try {
    const { q = '', type = 'all', ouDn = '' } = req.query;
    const adAuth = adAuthFromRequest(req);
    const results = ouDn
      ? await searchObjectsInOu(ouDn, type, adAuth)
      : await searchObjects(q, type, adAuth);
    await audit(req, {
      action: 'search',
      status: 'success',
      scopeType: type,
      scopeDn: ouDn || '',
      message: `Wyszukiwanie: "${q}"`,
      details: { query: q, type, ouDn, results: results.length }
    });
    res.json(results);
  } catch (error) {
    await audit(req, {
      action: 'search',
      status: 'error',
      message: error.message,
      details: { query: req.query?.q || '', type: req.query?.type || 'all', ouDn: req.query?.ouDn || '' }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/search/advanced', async (req, res) => {
  const options = {
    q: String(req.query.q || ''),
    type: String(req.query.type || 'all'),
    field: String(req.query.field || 'any'),
    ouDn: String(req.query.ouDn || ''),
    subtree: req.query.subtree !== '0',
    status: String(req.query.status || ''),
    logon: String(req.query.logon || ''),
    days: Number(req.query.days || 0),
    limit: Number(req.query.limit || 50)
  };
  try {
    const result = await advancedSearch(options, adAuthFromRequest(req));
    await audit(req, {
      action: 'search',
      status: 'success',
      scopeType: options.type,
      scopeDn: options.ouDn,
      message: `Wyszukiwanie: "${options.q}"`,
      details: { query: options.q, type: options.type, options, results: result.rows.length, truncated: result.truncated }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'search',
      status: 'error',
      scopeDn: options.ouDn,
      message: error.message,
      details: { query: options.q, type: options.type, options }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/object', async (req, res) => {
  try {
    const objectDn = req.query.dn;
    const details = await getObjectDetails(objectDn, adAuthFromRequest(req));
    await audit(req, {
      action: 'object_view',
      status: 'success',
      scopeDn: objectDn,
      message: 'Podgląd szczegółów obiektu'
    });
    res.json(details);
  } catch (error) {
    await audit(req, {
      action: 'object_view',
      status: 'error',
      scopeDn: req.query?.dn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/groups', async (req, res) => {
  try {
    const { userDn, addDns = [], removeDns = [] } = req.body;
    await updateUserGroups(userDn, addDns, removeDns, adAuthFromRequest(req));
    await audit(req, {
      action: 'user_groups_update',
      status: 'success',
      scopeType: 'user',
      scopeDn: userDn,
      message: 'Aktualizacja członkostwa grup',
      details: { added: addDns, removed: removeDns }
    });
    res.json({ updated: true });
  } catch (error) {
    await audit(req, {
      action: 'user_groups_update',
      status: 'error',
      scopeType: 'user',
      scopeDn: req.body?.userDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/group/members', async (req, res) => {
  try {
    const { groupDn, addMemberDns = [], removeMemberDns = [] } = req.body;
    await updateGroupMembers(groupDn, addMemberDns, removeMemberDns, adAuthFromRequest(req));
    await audit(req, {
      action: 'group_members_update',
      status: 'success',
      scopeType: 'group',
      scopeDn: groupDn,
      message: 'Aktualizacja członków grupy',
      details: { added: addMemberDns, removed: removeMemberDns }
    });
    res.json({ updated: true });
  } catch (error) {
    await audit(req, {
      action: 'group_members_update',
      status: 'error',
      scopeType: 'group',
      scopeDn: req.body?.groupDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/groups/copy', async (req, res) => {
  try {
    const { targetUserDn, referenceUserDn, selectedGroups } = req.body;
    const result = await copyGroupsFromReference(
      targetUserDn,
      referenceUserDn,
      selectedGroups || [],
      adAuthFromRequest(req)
    );
    await audit(req, {
      action: 'user_groups_copy',
      status: 'success',
      scopeType: 'user',
      scopeDn: targetUserDn,
      targetDn: referenceUserDn,
      message: 'Skopiowanie grup z użytkownika referencyjnego',
      details: { copiedGroups: selectedGroups || [] }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'user_groups_copy',
      status: 'error',
      scopeDn: req.body?.targetUserDn || '',
      targetDn: req.body?.referenceUserDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/object/move', async (req, res) => {
  try {
    const { objectDn, newParentOuDn } = req.body;
    const result = await moveObject(objectDn, newParentOuDn, adAuthFromRequest(req));
    await audit(req, {
      action: 'object_move',
      status: 'success',
      scopeDn: objectDn,
      targetDn: newParentOuDn,
      message: 'Przeniesienie obiektu do nowego OU'
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'object_move',
      status: 'error',
      scopeDn: req.body?.objectDn || '',
      targetDn: req.body?.newParentOuDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});


router.post('/api/object/enabled', async (req, res) => {
  try {
    const { objectDn, enabled } = req.body;
    const result = await setAccountEnabled(objectDn, Boolean(enabled), adAuthFromRequest(req));
    await audit(req, {
      action: 'account_enabled_toggle',
      status: 'success',
      scopeDn: objectDn,
      message: Boolean(enabled) ? 'Włączenie konta' : 'Wyłączenie konta',
      details: { enabled: Boolean(enabled) }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'account_enabled_toggle',
      status: 'error',
      scopeDn: req.body?.objectDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/object/soft-delete', async (req, res) => {
  try {
    const { objectDn } = req.body;
    const result = await softDeleteAccount(objectDn, adAuthFromRequest(req));
    await audit(req, {
      action: 'account_soft_delete',
      status: result.failedGroups.length ? 'error' : 'success',
      scopeDn: objectDn,
      targetDn: result.newDn,
      message: result.failedGroups.length
        ? `Soft delete konta: wyłączono i przeniesiono, ale nie usunięto z ${result.failedGroups.length} grup(y)`
        : 'Soft delete konta (wyłączenie, usunięcie z grup, przeniesienie)',
      details: {
        groupsBefore: result.groupsBefore,
        removedGroups: result.removedGroups,
        failedGroups: result.failedGroups
      }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'account_soft_delete',
      status: 'error',
      scopeDn: req.body?.objectDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/object/unlock', async (req, res) => {
  try {
    const { objectDn, targetOuDn } = req.body;
    const result = await unlockAccount(objectDn, targetOuDn, adAuthFromRequest(req));
    await audit(req, {
      action: 'account_unlock',
      status: 'success',
      scopeDn: objectDn,
      targetDn: targetOuDn,
      message: 'Odblokowanie konta (włączenie + przeniesienie z OU zablokowane_konta)'
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'account_unlock',
      status: 'error',
      scopeDn: req.body?.objectDn || '',
      targetDn: req.body?.targetOuDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/settings', async (req, res) => {
  try {
    const { objectDn, ...payload } = req.body;
    const result = await updateUserSettings(objectDn, payload, adAuthFromRequest(req));
    await audit(req, {
      action: 'user_settings_update',
      status: 'success',
      scopeType: 'user',
      scopeDn: objectDn,
      message: 'Aktualizacja ustawień użytkownika',
      details: {
        changedKeys: Object.keys(payload || {})
      }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'user_settings_update',
      status: 'error',
      scopeDn: req.body?.objectDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/group/create', async (req, res) => {
  try {
    const result = await createGroup(req.body, adAuthFromRequest(req));
    await audit(req, {
      action: 'group_create',
      status: 'success',
      scopeType: 'group',
      scopeDn: result?.dn || '',
      message: 'Utworzenie grupy',
      details: { payload: req.body }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'group_create',
      status: 'error',
      message: error.message,
      details: { payload: req.body }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/ou-children', async (req, res) => {
  try {
    const { parentDn, ouOnly } = req.query;
    const data = await listOuChildren(parentDn || undefined, ouOnly === '1', adAuthFromRequest(req));
    await audit(req, {
      action: 'ou_children_list',
      status: 'success',
      scopeDn: parentDn || '',
      message: 'Pobranie dzieci OU',
      details: { ouOnly: ouOnly === '1', count: data.length }
    });
    res.json(data);
  } catch (error) {
    await audit(req, {
      action: 'ou_children_list',
      status: 'error',
      scopeDn: req.query?.parentDn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/ou-search', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await searchOus(q, adAuthFromRequest(req));
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/user/certificates', async (req, res) => {
  try {
    const dn = req.query.dn;
    const rows = await getUserCertificates(dn, adAuthFromRequest(req));
    await audit(req, {
      action: 'user_certificates_view',
      status: 'success',
      scopeType: 'user',
      scopeDn: dn || '',
      message: 'Podgląd certyfikatów użytkownika',
      details: { count: rows.length }
    });
    res.json(rows);
  } catch (error) {
    await audit(req, {
      action: 'user_certificates_view',
      status: 'error',
      scopeDn: req.query?.dn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/certificates/delete', async (req, res) => {
  try {
    const { userDn, fingerprint256 } = req.body;
    const result = await deleteUserCertificate(userDn, fingerprint256, adAuthFromRequest(req));
    const cert = result.certificate || {};
    await audit(req, {
      action: 'user_certificate_delete',
      status: 'success',
      scopeType: 'user',
      scopeDn: userDn,
      message: 'Usunięcie certyfikatu z konta użytkownika',
      details: {
        subject: cert.subject || '',
        issuer: cert.issuer || '',
        serialNumber: cert.serialNumber || '',
        thumbprint: cert.thumbprint || '',
        validTo: cert.validTo || ''
      }
    });
    res.json({ deleted: true });
  } catch (error) {
    await audit(req, {
      action: 'user_certificate_delete',
      status: 'error',
      scopeType: 'user',
      scopeDn: req.body?.userDn || '',
      message: error.message,
      details: { fingerprint256: req.body?.fingerprint256 || '' }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/computer/bitlocker', async (req, res) => {
  try {
    const dn = req.query.dn;
    const rows = await getBitlockerKeys(dn, adAuthFromRequest(req));
    await audit(req, {
      action: 'bitlocker_keys_view',
      status: 'success',
      scopeType: 'computer',
      scopeDn: dn || '',
      message: 'Podgląd kluczy BitLocker',
      details: { count: rows.length }
    });
    res.json(rows);
  } catch (error) {
    await audit(req, {
      action: 'bitlocker_keys_view',
      status: 'error',
      scopeDn: req.query?.dn || '',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/dashboard/stats', async (req, res) => {
  try {
    const data = await getDashboardStats(adAuthFromRequest(req));
    await audit(req, {
      action: 'dashboard_stats',
      status: 'success',
      message: 'Pobranie statystyk dashboardu'
    });
    res.json(data);
  } catch (error) {
    await audit(req, {
      action: 'dashboard_stats',
      status: 'error',
      message: error.message
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/user/suggest-login', async (req, res) => {
  try {
    const { firstName = '', lastName = '' } = req.query;
    const result = await suggestLogin(firstName, lastName, adAuthFromRequest(req));
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/user/login-availability', async (req, res) => {
  try {
    const login = String(req.query.login || '');
    if (!login) {
      res.json({ available: false });
      return;
    }
    const taken = await isSamAccountNameTaken(login, adAuthFromRequest(req));
    res.json({ available: !taken });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/create', async (req, res) => {
  try {
    // Permissions are resolved to groups here (not trusted from the client),
    // then merged with any additional groups picked in the wizard.
    const accountType = String(req.body?.userType || 'eskulap-domain');
    if (!ACCOUNT_TYPE_IDS.includes(accountType)) throw Object.assign(new Error('Nieznany typ konta'), { status: 400 });
    const body = { ...req.body, accountType };
    if (accountType === 'service') {
      // Service accounts: login svc_<name>, always in the OU from Settings.
      const login = String(body.login || '').trim();
      if (!/^svc_[A-Za-z0-9._-]+$/.test(login)) throw Object.assign(new Error('Login konta serwisowego musi mieć postać svc_nazwa (litery, cyfry, . _ -)'), { status: 400 });
      const { serviceAccountOuDn } = await getSettings();
      if (!serviceAccountOuDn) throw Object.assign(new Error('W Ustawieniach nie wskazano OU dla kont serwisowych'), { status: 400 });
      body.ouDn = serviceAccountOuDn;
    }
    const permissions = await getPermissionsByIds(body.permissionIds, accountType);
    const shareAccess = await resolveShareAccess(body.shareAccess, accountType);
    const groupMap = new Map();
    permissions.forEach((p) => p.groups.forEach((g) => groupMap.set(g.dn.toLowerCase(), g.dn)));
    shareAccess.forEach(({ group }) => groupMap.set(group.dn.toLowerCase(), group.dn));
    (Array.isArray(body.groups) ? body.groups : []).forEach((dn) => {
      if (dn) groupMap.set(String(dn).toLowerCase(), String(dn));
    });
    // A read-write share never comes with its read-only group as well.
    shareAccess.filter((a) => a.level === 'rw' && a.share.readGroup?.dn)
      .forEach(({ share }) => groupMap.delete(share.readGroup.dn.toLowerCase()));
    const result = await createUser({ ...body, groups: [...groupMap.values()] }, adAuthFromRequest(req));
    await audit(req, {
      action: 'user_create',
      status: result.failedGroups?.length ? 'error' : 'success',
      scopeType: 'user',
      scopeDn: result?.dn || '',
      message: result.failedGroups?.length
        ? `Utworzenie użytkownika (nie dodano do ${result.failedGroups.length} grup)`
        : 'Utworzenie użytkownika',
      details: {
        login: req.body?.login || '',
        userType: accountType,
        referenceUserDn: req.body?.referenceUserDn || '',
        permissions: permissions.map((p) => ({ id: p.id, name: p.name })),
        shares: shareAccess.map(({ share, level, group }) => ({ id: share.id, name: share.name, path: share.path, level, groupDn: group.dn })),
        settings: result?.settings || {},
        addedGroups: result?.addedGroups || [],
        failedGroups: result?.failedGroups || []
      }
    });
    res.json(result);
  } catch (error) {
    await audit(req, {
      action: 'user_create',
      status: 'error',
      message: error.message,
      details: { login: req.body?.login || '' }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

function registerCrudRoutes(basePath, auditPrefix, label, store) {
  router.get(basePath, async (req, res) => {
    try {
      res.json(await store.list());
    } catch (error) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  router.post(basePath, async (req, res) => {
    try {
      const item = await store.create(req.body, req.session?.user?.login || '');
      await audit(req, { action: `${auditPrefix}_create`, status: 'success', message: `Dodano ${label} „${item.name}”`, details: { item } });
      res.json(item);
    } catch (error) {
      await audit(req, { action: `${auditPrefix}_create`, status: 'error', message: error.message, details: { payload: req.body } });
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  router.put(`${basePath}/:id`, async (req, res) => {
    try {
      const { before, after } = await store.update(req.params.id, req.body, req.session?.user?.login || '');
      await audit(req, { action: `${auditPrefix}_update`, status: 'success', message: `Zmieniono ${label} „${after.name}”`, details: { before, after } });
      res.json(after);
    } catch (error) {
      await audit(req, { action: `${auditPrefix}_update`, status: 'error', message: error.message, details: { id: req.params.id } });
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  router.delete(`${basePath}/:id`, async (req, res) => {
    try {
      const item = await store.remove(req.params.id);
      await audit(req, { action: `${auditPrefix}_delete`, status: 'success', message: `Usunięto ${label} „${item.name}”`, details: { item } });
      res.json({ deleted: true });
    } catch (error) {
      await audit(req, { action: `${auditPrefix}_delete`, status: 'error', message: error.message, details: { id: req.params.id } });
      res.status(error.status || 500).json({ message: error.message });
    }
  });
}

router.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.put('/api/settings', async (req, res) => {
  try {
    const { before, after } = await updateSettings(req.body, req.session?.user?.login || '');
    await audit(req, { action: 'settings_update', status: 'success', message: 'Zmiana ustawień portalu', details: { before, after } });
    res.json(after);
  } catch (error) {
    await audit(req, { action: 'settings_update', status: 'error', message: error.message });
    res.status(error.status || 500).json({ message: error.message });
  }
});

registerCrudRoutes('/api/permissions', 'permission', 'uprawnienie', {
  list: listPermissions, create: createPermission, update: updatePermission, remove: deletePermission
});
registerCrudRoutes('/api/shares', 'share', 'udział', {
  list: listShares, create: createShare, update: updateShare, remove: deleteShare
});

router.get('/api/reports/stale-logons', async (req, res) => {
  const kind = req.query.kind === 'computer' ? 'computer' : 'user';
  const days = Math.max(1, Math.min(Number(req.query.days) || Number(req.query.years || 2) * 365, 36500));
  const includeDisabled = req.query.includeDisabled === '1';
  const ouDn = String(req.query.ouDn || '');
  try {
    const report = await staleLogons({ kind, days, includeDisabled, ouDn }, adAuthFromRequest(req));
    await audit(req, {
      action: 'report_stale_logons',
      status: 'success',
      scopeType: kind,
      scopeDn: ouDn,
      message: kind === 'computer' ? 'Wygenerowano raport nieaktywnych komputerów' : 'Wygenerowano raport nieaktywnych kont',
      details: { kind, days, includeDisabled, ouDn, records: report.length }
    });
    res.json(report);
  } catch (error) {
    await audit(req, {
      action: 'report_stale_logons',
      status: 'error',
      scopeType: kind,
      message: error.message,
      details: { kind, days, includeDisabled, ouDn }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/audit/object-logs', async (req, res) => {
  try {
    const dn = String(req.query.dn || '');
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const hideViews = req.query.hideViews !== '0';
    res.json(await getObjectEvents(dn, limit, { excludeActions: hideViews ? VIEW_ACTIONS : [] }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/api/audit/recent', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const rows = await readEvents(limit);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/api/audit/login-history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const rows = await getRecentLoginEvents(limit);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/api/reports/portal-activity', async (req, res) => {
  try {
    const report = await queryEvents({
      q: req.query.q || '',
      action: req.query.action || '',
      status: req.query.status || '',
      from: req.query.from || '',
      to: req.query.to || '',
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 20)
    });
    res.json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
