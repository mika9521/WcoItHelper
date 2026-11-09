const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../../utils/errors');

let kerberos = null;
try {
  // eslint-disable-next-line global-require
  kerberos = require('kerberos');
} catch {
  kerberos = null;
}

// On Linux, the `kerberos` package's GSSAPI client (initializeClient/step)
// authenticates using whatever ticket is already sitting in the active
// credential cache (KRB5CCNAME) - it has no "log in with this password"
// call of its own on this platform (that's Windows/SSPI only, see the
// package's own docs). So a ticket first has to be acquired the classic
// way: shell out to `kinit`, feed it the password on stdin, and point it at
// a cache file dedicated to this one request.
//
// KRB5CCNAME is a process-wide environment variable, and the native GSSAPI
// calls read it synchronously at call time, so every kinit+negotiate
// sequence in this process is serialized through this queue to avoid two
// concurrent requests (e.g. two different logged-in users) racing on it.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function runKinit(principal, password, ccachePath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('kinit', ['-c', ccachePath, principal]);
    } catch (error) {
      reject(new AppError(`Nie udało się uruchomić "kinit": ${error.message}`, 501));
      return;
    }

    let stderr = '';
    let settled = false;

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') {
        reject(new AppError(
          'Polecenie "kinit" nie jest zainstalowane na tym serwerze (pakiet krb5-user na Debian/Ubuntu lub krb5-workstation na RHEL) - wymagane dla SCCM_AUTH_MODE=kerberos',
          501
        ));
      } else {
        reject(error);
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new AppError(
          `Nie udało się uzyskać biletu Kerberos (kinit) dla "${principal}": ${stderr.trim() || `kod wyjścia ${code}`}`,
          502
        ));
      }
    });

    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

async function withTemporaryCcache(principal, password, action) {
  const ccachePath = path.join(os.tmpdir(), `sccm-krb5cc-${crypto.randomBytes(12).toString('hex')}`);
  await runKinit(principal, password, ccachePath);

  const previousCcName = process.env.KRB5CCNAME;
  process.env.KRB5CCNAME = `FILE:${ccachePath}`;
  try {
    return await action();
  } finally {
    if (previousCcName === undefined) delete process.env.KRB5CCNAME;
    else process.env.KRB5CCNAME = previousCcName;
    await fs.rm(ccachePath, { force: true }).catch(() => {});
  }
}

/**
 * Acquires a Kerberos ticket for `principal`/`password` and produces the
 * initial base64 SPNEGO token to send as `Authorization: Negotiate <token>`
 * for the given service principal name (`spn`, e.g. "HTTP@sccm01.domain").
 *
 * Returns { token, client } - `client` must be kept around and used for
 * `continueNegotiation` if the server challenges with a second leg.
 */
async function startNegotiation({ principal, password, spn }) {
  if (!kerberos) {
    throw new AppError(
      'Moduł "kerberos" nie jest zainstalowany/skompilowany na tym serwerze - wymagany dla SCCM_AUTH_MODE=kerberos (potrzebne są biblioteki krb5-dev przy instalacji)',
      501
    );
  }
  if (!principal || !password) {
    throw new AppError('Brak danych uwierzytelniających do uzyskania biletu Kerberos dla SCCM', 401);
  }

  return serialize(() => withTemporaryCcache(principal, password, async () => {
    const client = await kerberos.initializeClient(spn, {
      principal,
      mechOID: kerberos.GSS_MECH_OID_SPNEGO
    });
    const token = await client.step('');
    return { token, client };
  }));
}

/**
 * Feeds the server's continuation challenge (the base64 value from a
 * `WWW-Authenticate: Negotiate <challenge>` response) back into the same
 * client context to produce the next token, for servers that need a second
 * leg of the handshake. Must be called (and the resulting request sent)
 * before any other Kerberos negotiation starts, so this also runs through
 * the serialization queue.
 */
async function continueNegotiation(client, challengeToken) {
  return serialize(() => client.step(challengeToken));
}

module.exports = {
  isAvailable: () => Boolean(kerberos),
  startNegotiation,
  continueNegotiation
};
