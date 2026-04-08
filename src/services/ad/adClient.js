const { Client } = require('ldapts');
const env = require('../../config/env');

function createClient() {
  return new Client({
    url: env.ad.url,
    timeout: 8000,
    connectTimeout: 8000,
    tlsOptions: {
      rejectUnauthorized: env.ad.rejectUnauthorized
    }
  });
}

async function withServiceBind(action) {
  const client = createClient();
  try {
    await client.bind(env.ad.bindDn, env.ad.bindPassword);
    return await action(client);
  } finally {
    await client.unbind();
  }
}

async function withUserBind(userPrincipalName, password, action) {
  const client = createClient();
  try {
    await client.bind(userPrincipalName, password);
    return await action(client);
  } finally {
    await client.unbind();
  }
}

module.exports = { withServiceBind, withUserBind };
