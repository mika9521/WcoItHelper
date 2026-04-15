const dotenv = require('dotenv');
dotenv.config();

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function normalizeProtocol(value = 'ldaps') {
  const protocol = String(value).trim().toLowerCase();
  return protocol === 'ldap' ? 'ldap' : 'ldaps';
}

function defaultPort(protocol) {
  return protocol === 'ldap' ? '389' : '636';
}

function buildAdUrl(protocol) {
  if (process.env.AD_URL) return process.env.AD_URL;
  const host = process.env.AD_HOST || 'localhost';
  const port = process.env.AD_PORT || defaultPort(protocol);
  return `${protocol}://${host}:${port}`;
}

const protocol = normalizeProtocol(process.env.AD_PROTOCOL);
const tlsEnabled = parseBoolean(process.env.AD_TLS_ENABLED, protocol === 'ldaps');

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  debug: parseBoolean(process.env.DEBUG, false) || parseBoolean(process.env.AD_DEBUG, false),
  ad: {
    protocol,
    url: buildAdUrl(protocol),
    tlsEnabled,
    baseDn: process.env.AD_BASE_DN,
    bindDn: process.env.AD_BIND_DN,
    bindPassword: process.env.AD_BIND_PASSWORD,
    useLoggedUserBind: parseBoolean(process.env.AD_USE_LOGGED_USER_BIND, false),
    allowedGroupDn: process.env.AD_ALLOWED_GROUP_DN,
    allowedUsers: (process.env.AD_ALLOWED_USERS || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    rejectUnauthorized: parseBoolean(process.env.AD_TLS_REJECT_UNAUTHORIZED, true)
  }
};
