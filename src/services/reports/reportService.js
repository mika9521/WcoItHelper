const { staleAccounts } = require('../ad/adService');

function fileTimeToDate(fileTime) {
  if (!fileTime || fileTime === '0') return null;
  try {
    const windowsEpoch = 116444736000000000n;
    const ms = Number((BigInt(fileTime) - windowsEpoch) / 10000n);
    return ms > 0 ? new Date(ms) : null;
  } catch {
    return null;
  }
}

// Newest of lastLogonTimestamp (replicated) and lastLogon (answering DC).
function lastLogonDate(obj) {
  const dates = [fileTimeToDate(obj.lastLogonTimestamp), fileTimeToDate(obj.lastLogon)].filter(Boolean);
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

async function staleLogons({ kind = 'user', days = 730, includeDisabled = false, ouDn = '' } = {}, authContext = null) {
  const rows = await staleAccounts(kind, days, { includeDisabled, ouDn }, authContext);
  const threshold = Date.now() - days * 86400000;
  return rows
    .map((obj) => ({
      ...obj,
      lastLogonDate: lastLogonDate(obj),
      pwdLastSetDate: fileTimeToDate(obj.pwdLastSet)
    }))
    // lastLogon from the answering DC can be newer than the replicated value.
    .filter((obj) => !obj.lastLogonDate || obj.lastLogonDate.getTime() < threshold)
    .sort((a, b) => (a.lastLogonDate?.getTime() ?? 0) - (b.lastLogonDate?.getTime() ?? 0));
}

module.exports = { staleLogons };
