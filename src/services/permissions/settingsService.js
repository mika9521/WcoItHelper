// Portal settings stored in data/settings.json (single document).
const fs = require('fs/promises');
const path = require('path');
const { AppError } = require('../../utils/errors');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULTS = { serviceAccountOuDn: '' };

let queue = Promise.resolve();

async function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(FILE, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw new AppError(`Nie można odczytać ustawień (${FILE}): ${error.message}`, 500);
  }
}

async function updateSettings(input = {}, actor = '') {
  const run = queue.then(async () => {
    const before = await getSettings();
    const after = {
      ...before,
      serviceAccountOuDn: String(input.serviceAccountOuDn ?? before.serviceAccountOuDn ?? '').trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: actor
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(after, null, 2), 'utf8');
    await fs.rename(tmp, FILE);
    return { before, after };
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { getSettings, updateSettings };
