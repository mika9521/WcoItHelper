const express = require('express');
const { getDomainFromBaseDn } = require('../services/ad/adService');
const { logEvent } = require('../services/audit/auditLogService');

const router = express.Router();

router.get('/', async (req, res) => {
  await logEvent({
    action: 'view_dashboard',
    status: 'success',
    actorLogin: req.session?.user?.login || '',
    actorDisplayName: req.session?.user?.displayName || '',
    actorDn: req.session?.user?.dn || '',
    sourceIp: req.ip,
    userAgent: req.get('user-agent'),
    message: 'Otwarcie dashboardu'
  });
  res.render('index', { user: req.session.user, adDomain: getDomainFromBaseDn() });
});

module.exports = router;
