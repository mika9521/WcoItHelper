const http = require('http');
const https = require('https');
const { URL } = require('url');
const httpntlm = require('httpntlm');
const env = require('../../config/env');
const { AppError } = require('../../utils/errors');

// NOTE: this client has not been exercised against a real SCCM site (none was
// reachable in the environment this code was written in). The class/field
// names below follow the standard, out-of-the-box AdminService schema; if
// your site customizes hardware inventory classes or the AdminService path,
// this is the one file to adjust. See README.md "SCCM" section.

function ntlmRequest(method, options) {
  return new Promise((resolve, reject) => {
    httpntlm[method](options, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
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
    return `Serwer oferuje uwierzytelnianie: ${schemes} (bez NTLM). Ten portal obsługuje tylko NTLM. W IIS dla AdminService włącz dostawcę „NTLM” w Windows Authentication – samo „Negotiate”/Kerberos nie wystarczy. Jeśli w Twojej organizacji NTLM jest celowo zablokowany (np. politykami GPO w szpitalu), ta integracja w obecnej postaci nie zadziała i wymaga wsparcia dla Kerberos zamiast NTLM.`;
  }
  return `Serwer oferuje NTLM (${schemes}), ale negocjacja mimo to się nie powiodła – sprawdź SCCM_DOMAIN (nazwa NetBIOS vs DNS) oraz poprawność SCCM_SERVICE_USERNAME / hasła konta serwisowego.`;
}

function resolveCredentials(authContext) {
  if (!env.sccm.url) {
    throw new AppError('Integracja SCCM nie jest skonfigurowana (ustaw SCCM_URL w .env)', 501);
  }

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

async function sccmRequest(authContext, path) {
  const creds = resolveCredentials(authContext);
  const url = `${env.sccm.url}/${path}`;

  let res;
  try {
    res = await ntlmRequest('get', {
      url,
      username: creds.username,
      password: creds.password,
      domain: creds.domain,
      headers: { Accept: 'application/json' },
      rejectUnauthorized: env.sccm.rejectUnauthorized
    });
  } catch (error) {
    const diagnosis = await diagnoseNtlmFailure(url);
    throw new AppError(`Nie udało się połączyć z SCCM AdminService: ${error.message}. ${diagnosis}`, 502);
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new AppError(
      'SCCM AdminService odrzucił uwierzytelnianie – sprawdź SCCM_SERVICE_USERNAME/SCCM_DOMAIN lub uprawnienia konta',
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
