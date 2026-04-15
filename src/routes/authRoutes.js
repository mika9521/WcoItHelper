const express = require('express');
const env = require('../config/env');
const { authenticate } = require('../services/ad/adService');
const { logEvent } = require('../services/audit/auditLogService');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await authenticate(login, password);
    req.session.user = {
      ...user,
      adAuth: env.ad.useLoggedUserBind
        ? {
            userPrincipalName: user.userPrincipalName,
            password
          }
        : null
    };
    await logEvent({
      action: 'login',
      status: 'success',
      actorLogin: user.login,
      actorDisplayName: user.displayName,
      actorDn: user.dn,
      sourceIp: req.ip,
      userAgent: req.get('user-agent'),
      message: 'Pomyślne logowanie do portalu'
    });
    res.redirect('/');
  } catch (error) {
    await logEvent({
      action: 'login',
      status: 'error',
      actorLogin: req.body?.login || '',
      sourceIp: req.ip,
      userAgent: req.get('user-agent'),
      message: error.message
    });
    res.status(error.status || 401).render('login', { error: error.message });
  }
});

router.post('/logout', (req, res) => {
  const user = req.session?.user;
  logEvent({
    action: 'logout',
    status: 'success',
    actorLogin: user?.login || '',
    actorDisplayName: user?.displayName || '',
    actorDn: user?.dn || '',
    sourceIp: req.ip,
    userAgent: req.get('user-agent'),
    message: 'Wylogowanie z portalu'
  }).catch(() => {});
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
