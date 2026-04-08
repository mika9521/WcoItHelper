const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  debug: process.env.DEBUG === 'true' || process.env.AD_DEBUG === 'true',
  ad: {
    url: process.env.AD_URL,
    baseDn: process.env.AD_BASE_DN,
    bindDn: process.env.AD_BIND_DN,
    bindPassword: process.env.AD_BIND_PASSWORD,
    allowedGroupDn: process.env.AD_ALLOWED_GROUP_DN,
    allowedUsers: (process.env.AD_ALLOWED_USERS || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    rejectUnauthorized: process.env.AD_TLS_REJECT_UNAUTHORIZED === 'true'
  }
};
