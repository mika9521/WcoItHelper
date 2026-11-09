const http = require('http');
const https = require('https');
const { URL } = require('url');
const httpntlm = require('httpntlm');
const env = require('../../config/env');
const { AppError } = require('../../utils/errors');
const kerberosAuth = require('./kerberosAuth');

// NOTE: this client has not been exercised against a real SCCM site. The
// class/field names below follow the standard, out-of-the-box AdminService
// schema; if your site customizes hardware inventory classes or the
// AdminService path, this is the one file to adjust. See README.md "SCCM"
// section, including the troubleshooting notes for both auth modes.

function ntlmRequest(method, options) {
  return new Promise((resolve, reject) => {
    httpntlm[method](options, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function rawGet(targetUrl, { headers, agent, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        agent,
        rejectUnauthorized,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// httpntlm sends `Authorization: NTLM <type1>` straight away and expects the
// server's 401 to answer with `WWW-Authenticate: NTLM <type2>`. When that
// header is missing or offers a different scheme (most often because IIS
// only has "Negotiate"/Kerberos enabled, or SCCM_URL isn't actually pointing
// at AdminService), httpntlm's parser fails with a generic, unhelpful error.
// This does a plain, unauthenticated request to the same URL to see what the
// server is really offering, so the error we raise says exactly what to fix.
function probeAuthSchemes(targetUrl) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve(null);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        rejectUnauthorized: env.sccm.rejectUnauthorized,
        timeout: 5000
      },
      (res) => {
        res.resume();
        const header = res.headers['www-authenticate'];
        resolve({ statusCode: res.statusCode, wwwAuthenticate: header ? [].concat(header) : [] });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function diagnoseNtlmFailure(targetUrl) {
  const probe = await probeAuthSchemes(targetUrl);
  if (!probe) {
    return 'Nie udało się nawet połączyć bezpośrednio z serwerem, aby zdiagnozować problem – sprawdź SCCM_URL, sieć/firewall i certyfikat TLS (SCCM_TLS_REJECT_UNAUTHORIZED).';
  }
  if (probe.statusCode !== 401) {
    return `Serwer odpowiedział kodem ${probe.statusCode} zamiast 401 (żądanie uwierzytelnienia) – sprawdź, czy SCCM_URL faktycznie wskazuje na AdminService (np. czy to nie strona logowania/błędu/przekierowania).`;
  }
  const schemes = probe.wwwAuthenticate.map((h) => h.split(/\s+/)[0]).filter(Boolean).join(', ');
  if (!schemes) {
    return 'Serwer zwrócił 401, ale bez nagłówka WWW-Authenticate – prawdopodobnie uwierzytelnianie Windows jest wyłączone dla tej ścieżki w IIS.';
  }
  if (!/ntlm/i.test(schemes)) {
    return `Serwer oferuje uwierzytelnianie: ${schemes} (bez NTLM). SCCM_AUTH_MODE=ntlm obsługuje tylko NTLM. W IIS dla AdminService włącz dostawcę „NTLM” w Windows Authentication, albo przełącz portal na SCCM_AUTH_MODE=kerberos (patrz README).`;
  }
  return `Serwer oferuje NTLM (${schemes}), ale negocjacja mimo to się nie powiodła – sprawdź SCCM_DOMAIN (nazwa NetBIOS vs DNS) oraz poprawność SCCM_SERVICE_USERNAME / hasła konta serwisowego.`;
}

function resolveCredentials(authContext) {
  if (env.ad.useLoggedUserBind) {
    const username = authContext?.username;
    const password = authContext?.password;
    if (!username || !password) {
      throw new AppError('Brak poświadczeń zalogowanego użytkownika do operacji SCCM', 401);
    }
    return { username, password, domain: env.sccm.domain };
  }

  if (!env.sccm.serviceUsername || !env.ad.bindPassword) {
    throw new AppError('Brak skonfigurowanego konta serwisowego SCCM (ustaw SCCM_SERVICE_USERNAME w .env)', 501);
  }
  return { username: env.sccm.serviceUsername, password: env.ad.bindPassword, domain: env.sccm.domain };
}

async function performNtlmRequest(authContext, targetUrl) {
  const creds = resolveCredentials(authContext);
  try {
    return await ntlmRequest('get', {
      url: targetUrl,
      username: creds.username,
      password: creds.password,
      domain: creds.domain,
      headers: { Accept: 'application/json' },
      rejectUnauthorized: env.sccm.rejectUnauthorized
    });
  } catch (error) {
    const diagnosis = await diagnoseNtlmFailure(targetUrl);
    throw new AppError(`Nie udało się połączyć z SCCM AdminService: ${error.message}. ${diagnosis}`, 502);
  }
}

function extractNegotiateChallenge(wwwAuthenticateHeader) {
  const header = [].concat(wwwAuthenticateHeader || []).find((h) => /^Negotiate\s/i.test(h));
  return header ? header.replace(/^Negotiate\s+/i, '').trim() : '';
}

async function performKerberosRequest(authContext, targetUrl) {
  const creds = resolveCredentials(authContext);
  if (!env.sccm.spn) {
    throw new AppError(
      'Nie udało się wyznaczyć SPN serwera SCCM – ustaw SCCM_SPN w .env (np. "HTTP@sccm01.hospital.local")',
      501
    );
  }
  if (!env.sccm.kerberosRealm) {
    throw new AppError('Nie udało się wyznaczyć realm Kerberos – ustaw SCCM_KERBEROS_REALM w .env', 501);
  }
  const principal = `${creds.username}@${env.sccm.kerberosRealm}`;

  let negotiation;
  try {
    negotiation = await kerberosAuth.startNegotiation({ principal, password: creds.password, spn: env.sccm.spn });
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Nie udało się uzyskać biletu Kerberos: ${error.message}`, 502);
  }

  const isHttps = targetUrl.startsWith('https:');
  const agent = isHttps
    ? new https.Agent({ keepAlive: true, rejectUnauthorized: env.sccm.rejectUnauthorized })
    : new http.Agent({ keepAlive: true });

  let res;
  try {
    res = await rawGet(targetUrl, {
      headers: { Accept: 'application/json', Authorization: `Negotiate ${negotiation.token}` },
      agent,
      rejectUnauthorized: env.sccm.rejectUnauthorized
    });

    // Some IIS/HTTP.sys configurations need a second leg even for Kerberos:
    // the server challenges back with a continuation token, which has to be
    // fed into the same security context and the result sent on the same
    // (keep-alive) connection.
    if (res.statusCode === 401) {
      const challengeToken = extractNegotiateChallenge(res.headers['www-authenticate']);
      if (challengeToken) {
        const nextToken = await kerberosAuth.continueNegotiation(negotiation.client, challengeToken);
        if (nextToken) {
          res = await rawGet(targetUrl, {
            headers: { Accept: 'application/json', Authorization: `Negotiate ${nextToken}` },
            agent,
            rejectUnauthorized: env.sccm.rejectUnauthorized
          });
        }
      }
    }
  } catch (error) {
    throw new AppError(`Nie udało się połączyć z SCCM AdminService (Kerberos): ${error.message}`, 502);
  } finally {
    agent.destroy();
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new AppError(
      `SCCM AdminService odrzucił uwierzytelnianie Kerberos (${res.statusCode}) – sprawdź SCCM_SPN ("${env.sccm.spn}"), SCCM_KERBEROS_REALM ("${env.sccm.kerberosRealm}") oraz czy konto "${principal}" ma uprawnienia do odczytu w SCCM`,
      res.statusCode
    );
  }

  return res;
}

function handleSccmResponse(res) {
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new AppError(
      'SCCM AdminService odrzucił uwierzytelnianie – sprawdź konfigurację konta/SPN/realm w .env',
      res.statusCode
    );
  }
  if (res.statusCode === 404) return null;
  if (res.statusCode >= 400) {
    throw new AppError(`Błąd SCCM AdminService (${res.statusCode}): ${String(res.body || '').slice(0, 300)}`, 502);
  }

  try {
    return JSON.parse(res.body);
  } catch {
    throw new AppError('Nieprawidłowa odpowiedź SCCM AdminService (oczekiwano JSON)', 502);
  }
}

async function sccmRequest(authContext, path) {
  if (!env.sccm.url) {
    throw new AppError('Integracja SCCM nie jest skonfigurowana (ustaw SCCM_URL w .env)', 501);
  }
  const url = `${env.sccm.url}/${path}`;

  const res = env.sccm.authMode === 'kerberos'
    ? await performKerberosRequest(authContext, url)
    : await performNtlmRequest(authContext, url);

  return handleSccmResponse(res);
}

function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function buildODataQuery({ filter, select, top } = {}) {
  const params = new URLSearchParams();
  if (filter) params.set('$filter', filter);
  if (select) params.set('$select', select);
  if (top) params.set('$top', String(top));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function queryList(authContext, className, options) {
  const data = await sccmRequest(authContext, `${className}${buildODataQuery(options)}`);
  return (data && data.value) || [];
}

async function queryById(authContext, className, id) {
  return sccmRequest(authContext, `${className}(${id})`);
}

function mapDevice(row) {
  return {
    resourceId: row.ResourceID,
    name: row.Name,
    isClient: Boolean(row.Client),
    operatingSystem: row.OperatingSystemNameandVersion || '',
    lastLogonUser: row.LastLogonUserName || '',
    domain: row.ResourceDomainORWorkgroup || ''
  };
}

async function searchDevices(query, authContext = null) {
  const term = escapeODataString(query);
  const rows = await queryList(authContext, 'SMS_R_System', {
    filter: term ? `substringof('${term}', Name)` : undefined,
    select: 'ResourceID,Name,Client,OperatingSystemNameandVersion,LastLogonUserName,ResourceDomainORWorkgroup',
    top: 50
  });
  return rows.map(mapDevice);
}

async function getDeviceByName(name, authContext = null) {
  const term = escapeODataString(name);
  const rows = await queryList(authContext, 'SMS_R_System', {
    filter: `Name eq '${term}'`,
    select: 'ResourceID,Name',
    top: 1
  });
  return rows[0] ? mapDevice(rows[0]) : null;
}

async function getDeviceDetails(resourceId, authContext = null) {
  const id = Number(resourceId);
  if (!Number.isFinite(id)) throw new AppError('Nieprawidłowy identyfikator zasobu SCCM', 400);

  const system = await queryById(authContext, 'SMS_R_System', id);
  if (!system) throw new AppError('Nie znaleziono urządzenia w SCCM', 404);

  let lastHardwareScan = '';
  try {
    const statusRows = await queryList(authContext, 'SMS_G_System_WORKSTATION_STATUS', {
      filter: `ResourceID eq ${id}`,
      select: 'LastHardwareScan'
    });
    lastHardwareScan = statusRows[0]?.LastHardwareScan || '';
  } catch {
    // The inventory status class may not be populated for every device
    // (e.g. never scanned yet) or may be named differently on some sites;
    // not having it shouldn't break the rest of the device detail view.
  }

  return {
    ...mapDevice(system),
    adSiteName: system.ADSiteName || '',
    ipAddresses: Array.isArray(system.IPAddresses) ? system.IPAddresses : (system.IPAddresses ? [system.IPAddresses] : []),
    lastHardwareScan
  };
}

async function getPrimaryUser(samAccountName, authContext = null) {
  const login = String(samAccountName || '').trim();
  if (!login) return [];
  const escaped = escapeODataString(login);
  const rows = await queryList(authContext, 'SMS_UserMachineRelationship', {
    filter: `substringof('\\${escaped}', UniqueUserName)`,
    select: 'ResourceName,UniqueUserName'
  });
  return [...new Set(rows.map((row) => row.ResourceName).filter(Boolean))];
}

module.exports = {
  searchDevices,
  getDeviceByName,
  getDeviceDetails,
  getPrimaryUser
};
