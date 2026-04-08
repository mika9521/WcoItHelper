const { searchObjects } = require('../ad/adService');

function fileTimeToDate(fileTime) {
  if (!fileTime || fileTime === '0') return null;
  const windowsEpoch = 116444736000000000n;
  const ms = Number((BigInt(fileTime) - windowsEpoch) / 10000n);
  return new Date(ms);
}

async function staleLogons(years = 2) {
  const users = await searchObjects('', 'user');
  const threshold = new Date();
  threshold.setFullYear(threshold.getFullYear() - years);

  return users
    .map((u) => ({
      ...u,
      lastLogonDate: fileTimeToDate(u.lastLogonTimestamp)
    }))
    .filter((u) => !u.lastLogonDate || u.lastLogonDate < threshold);
}

module.exports = { staleLogons };
