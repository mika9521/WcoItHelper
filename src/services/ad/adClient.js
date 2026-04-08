const { Client } = require('ldapts');
const env = require('../../config/env');

function debugLog(message, payload = {}) {
  if (!env.debug) return;
  // eslint-disable-next-line no-console
  console.debug(`[AD DEBUG] ${new Date().toISOString()} ${message}`, payload);
}

function formatError(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    stack: error?.stack
  };
}

function createClient() {
  debugLog('Tworzenie klienta LDAP', {
    url: env.ad.url,
    rejectUnauthorized: env.ad.rejectUnauthorized
  });

  const client = new Client({
    url: env.ad.url,
    timeout: 8000,
    connectTimeout: 8000,
    tlsOptions: {
      rejectUnauthorized: env.ad.rejectUnauthorized
    }
  });

  client.on('connectError', (error) => {
    debugLog('Błąd połączenia LDAP (connectError)', formatError(error));
  });
  client.on('error', (error) => {
    debugLog('Błąd klienta LDAP (error)', formatError(error));
  });

  return client;
}

async function withServiceBind(action) {
  const client = createClient();
  try {
    debugLog('Próba bind serwisowego', { bindDn: env.ad.bindDn });
    await client.bind(env.ad.bindDn, env.ad.bindPassword);
    debugLog('Bind serwisowy OK');
    return await action(client);
  } catch (error) {
    debugLog('Bind/akcja serwisowa zakończona błędem', formatError(error));
    throw error;
  } finally {
    try {
      await client.unbind();
      debugLog('Unbind serwisowy OK');
    } catch (error) {
      debugLog('Błąd podczas unbind serwisowego', formatError(error));
    }
  }
}

async function withUserBind(userPrincipalName, password, action) {
  const client = createClient();
  try {
    debugLog('Próba bind użytkownika', { userPrincipalName });
    await client.bind(userPrincipalName, password);
    debugLog('Bind użytkownika OK', { userPrincipalName });
    return await action(client);
  } catch (error) {
    debugLog('Bind/akcja użytkownika zakończona błędem', {
      userPrincipalName,
      ...formatError(error)
    });
    throw error;
  } finally {
    try {
      await client.unbind();
      debugLog('Unbind użytkownika OK', { userPrincipalName });
    } catch (error) {
      debugLog('Błąd podczas unbind użytkownika', {
        userPrincipalName,
        ...formatError(error)
      });
    }
  }
}

module.exports = { withServiceBind, withUserBind };
