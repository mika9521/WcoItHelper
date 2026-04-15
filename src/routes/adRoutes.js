const express = require('express');
const {
  searchObjects,
  searchObjectsInOu,
  getObjectDetails,
  updateUserGroups,
  copyGroupsFromReference,
  moveObject,
  createUser,
  createGroup,
  setAccountEnabled,
  softDeleteAccount,
  updateUserSettings,
  listOuChildren,
  getDashboardStats
} = require('../services/ad/adService');
const { staleLogons } = require('../services/reports/reportService');
const {
  logEvent,
  readEvents,
  getObjectEvents,
  getRecentLoginEvents
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
      status: 'success',
      scopeDn: objectDn,
      message: 'Soft delete konta (wyłączenie + przeniesienie)'
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

router.post('/api/user/create', async (req, res) => {
  try {
    const result = await createUser(req.body, adAuthFromRequest(req));
    await audit(req, {
      action: 'user_create',
      status: 'success',
      scopeType: 'user',
      scopeDn: result?.dn || '',
      message: 'Utworzenie użytkownika',
      details: { login: req.body?.login || '' }
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

router.get('/api/reports/stale-logons', async (req, res) => {
  try {
    const years = Number(req.query.years || 2);
    const report = await staleLogons(years, adAuthFromRequest(req));
    await audit(req, {
      action: 'report_stale_logons',
      status: 'success',
      message: 'Wygenerowano raport nieaktywnych kont',
      details: { years, records: report.length }
    });
    res.json(report);
  } catch (error) {
    await audit(req, {
      action: 'report_stale_logons',
      status: 'error',
      message: error.message,
      details: { years: Number(req.query?.years || 2) }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/audit/object-logs', async (req, res) => {
  try {
    const dn = String(req.query.dn || '');
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const rows = await getObjectEvents(dn, limit);
    res.json(rows);
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

module.exports = router;
