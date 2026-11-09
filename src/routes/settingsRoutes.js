const express = require('express');
const {
  readSettings,
  addDefaultNewUserGroup,
  removeDefaultNewUserGroup,
  createPermissionCategory,
  deletePermissionCategory,
  addGroupToCategory,
  removeGroupFromCategory
} = require('../services/settings/settingsService');
const { logEvent } = require('../services/audit/auditLogService');

const router = express.Router();

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
  await logEvent({ ...actorFromRequest(req), ...payload });
}

router.get('/api/settings', async (req, res) => {
  try {
    const settings = await readSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/api/settings/default-groups', async (req, res) => {
  try {
    const { groupDn } = req.body;
    const settings = await addDefaultNewUserGroup(groupDn);
    await audit(req, {
      action: 'settings_default_group_add',
      status: 'success',
      scopeDn: groupDn || '',
      message: 'Dodanie domyślnej grupy dla nowych kont'
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/api/settings/default-groups', async (req, res) => {
  try {
    const { groupDn } = req.body;
    const settings = await removeDefaultNewUserGroup(groupDn);
    await audit(req, {
      action: 'settings_default_group_remove',
      status: 'success',
      scopeDn: groupDn || '',
      message: 'Usunięcie domyślnej grupy dla nowych kont'
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/api/settings/categories', async (req, res) => {
  try {
    const { name } = req.body;
    const category = await createPermissionCategory(name);
    await audit(req, {
      action: 'settings_category_create',
      status: 'success',
      message: `Utworzenie kategorii uprawnień: ${name}`
    });
    res.json(category);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/api/settings/categories/:id', async (req, res) => {
  try {
    const settings = await deletePermissionCategory(req.params.id);
    await audit(req, {
      action: 'settings_category_delete',
      status: 'success',
      message: `Usunięcie kategorii uprawnień (${req.params.id})`
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/api/settings/categories/:id/groups', async (req, res) => {
  try {
    const { groupDn } = req.body;
    const category = await addGroupToCategory(req.params.id, groupDn);
    await audit(req, {
      action: 'settings_category_group_add',
      status: 'success',
      scopeDn: groupDn || '',
      message: `Dodanie grupy do kategorii uprawnień (${req.params.id})`
    });
    res.json(category);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/api/settings/categories/:id/groups', async (req, res) => {
  try {
    const { groupDn } = req.body;
    const category = await removeGroupFromCategory(req.params.id, groupDn);
    await audit(req, {
      action: 'settings_category_group_remove',
      status: 'success',
      scopeDn: groupDn || '',
      message: `Usunięcie grupy z kategorii uprawnień (${req.params.id})`
    });
    res.json(category);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
