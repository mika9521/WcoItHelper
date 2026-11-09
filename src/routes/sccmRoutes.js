const express = require('express');
const env = require('../config/env');
const { searchDevices, getDeviceByName, getDeviceDetails, getPrimaryUser } = require('../services/sccm/sccmClient');
const { logEvent } = require('../services/audit/auditLogService');

const router = express.Router();

function sccmAuthFromRequest(req) {
  if (!env.ad.useLoggedUserBind) return null;
  return {
    username: req.session?.user?.login || '',
    password: req.session?.user?.adAuth?.password || ''
  };
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
  await logEvent({ ...actorFromRequest(req), ...payload });
}

router.get('/api/sccm/search', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const rows = await searchDevices(q, sccmAuthFromRequest(req));
    await audit(req, {
      action: 'sccm_search',
      status: 'success',
      message: `Wyszukiwanie SCCM: "${q}"`,
      details: { query: q, results: rows.length }
    });
    res.json(rows);
  } catch (error) {
    await audit(req, {
      action: 'sccm_search',
      status: 'error',
      message: error.message,
      details: { query: req.query?.q || '' }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/sccm/device', async (req, res) => {
  try {
    const { resourceId, name } = req.query;
    let device = null;
    if (resourceId) {
      device = await getDeviceDetails(resourceId, sccmAuthFromRequest(req));
    } else if (name) {
      const summary = await getDeviceByName(String(name), sccmAuthFromRequest(req));
      if (!summary) return res.status(404).json({ message: 'Nie znaleziono urządzenia w SCCM' });
      device = await getDeviceDetails(summary.resourceId, sccmAuthFromRequest(req));
    } else {
      return res.status(400).json({ message: 'Podaj resourceId lub name' });
    }
    await audit(req, {
      action: 'sccm_device_view',
      status: 'success',
      message: `Podgląd urządzenia SCCM: ${device.name}`,
      details: { resourceId: device.resourceId }
    });
    res.json(device);
  } catch (error) {
    await audit(req, {
      action: 'sccm_device_view',
      status: 'error',
      message: error.message,
      details: { resourceId: req.query?.resourceId || '', name: req.query?.name || '' }
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/api/sccm/primary-user', async (req, res) => {
  try {
    const login = String(req.query.login || '');
    const devices = await getPrimaryUser(login, sccmAuthFromRequest(req));
    res.json({ devices });
  } catch (error) {
    // This endpoint is polled per search-result row; keep failures quiet
    // (no audit spam) and let the UI fall back to "-".
    res.status(error.status || 500).json({ message: error.message });
  }
});

module.exports = router;
