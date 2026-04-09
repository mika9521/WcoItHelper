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
  listOuChildren,
  getDashboardStats
} = require('../services/ad/adService');
const { staleLogons } = require('../services/reports/reportService');

const router = express.Router();

router.get('/api/search', async (req, res) => {
  try {
    const { q = '', type = 'all', ouDn = '' } = req.query;
    const results = ouDn
      ? await searchObjectsInOu(ouDn, type)
      : await searchObjects(q, type);
    res.json(results);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/object', async (req, res) => {
  try {
    const details = await getObjectDetails(req.query.dn);
    res.json(details);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/groups', async (req, res) => {
  try {
    const { userDn, addDns = [], removeDns = [] } = req.body;
    await updateUserGroups(userDn, addDns, removeDns);
    res.json({ updated: true });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/groups/copy', async (req, res) => {
  try {
    const { targetUserDn, referenceUserDn, selectedGroups } = req.body;
    const result = await copyGroupsFromReference(targetUserDn, referenceUserDn, selectedGroups || []);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/object/move', async (req, res) => {
  try {
    const { objectDn, newParentOuDn } = req.body;
    const result = await moveObject(objectDn, newParentOuDn);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});


router.post('/api/object/enabled', async (req, res) => {
  try {
    const { objectDn, enabled } = req.body;
    const result = await setAccountEnabled(objectDn, Boolean(enabled));
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/group/create', async (req, res) => {
  try {
    const result = await createGroup(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/ou-children', async (req, res) => {
  try {
    const { parentDn, ouOnly } = req.query;
    const data = await listOuChildren(parentDn || undefined, ouOnly === '1');
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/dashboard/stats', async (req, res) => {
  try {
    const data = await getDashboardStats();
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.post('/api/user/create', async (req, res) => {
  try {
    const result = await createUser(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/reports/stale-logons', async (req, res) => {
  try {
    const years = Number(req.query.years || 2);
    const report = await staleLogons(years);
    res.json(report);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

module.exports = router;
