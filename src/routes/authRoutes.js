const express = require('express');
const { authenticate } = require('../services/ad/adService');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await authenticate(login, password);
    req.session.user = user;
    res.redirect('/');
  } catch (error) {
    res.status(error.status || 401).render('login', { error: error.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
