const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'portal-settings.json');

const DEFAULT_SETTINGS = {
  defaultNewUserGroups: [],
  permissionCategories: []
};

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(SETTINGS_FILE);
  } catch {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
  }
}

async function readSettings() {
  await ensureStore();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      defaultNewUserGroups: Array.isArray(parsed.defaultNewUserGroups) ? parsed.defaultNewUserGroups : [],
      permissionCategories: Array.isArray(parsed.permissionCategories) ? parsed.permissionCategories : []
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(settings) {
  await ensureStore();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

async function getDefaultNewUserGroups() {
  const settings = await readSettings();
  return settings.defaultNewUserGroups;
}

async function addDefaultNewUserGroup(groupDn) {
  const settings = await readSettings();
  if (!groupDn || settings.defaultNewUserGroups.includes(groupDn)) return settings;
  settings.defaultNewUserGroups.push(groupDn);
  return writeSettings(settings);
}

async function removeDefaultNewUserGroup(groupDn) {
  const settings = await readSettings();
  settings.defaultNewUserGroups = settings.defaultNewUserGroups.filter((dn) => dn !== groupDn);
  return writeSettings(settings);
}

async function listPermissionCategories() {
  const settings = await readSettings();
  return settings.permissionCategories;
}

async function createPermissionCategory(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Nazwa kategorii jest wymagana');
  const settings = await readSettings();
  const category = { id: crypto.randomUUID(), name: trimmed, groupDns: [] };
  settings.permissionCategories.push(category);
  await writeSettings(settings);
  return category;
}

async function deletePermissionCategory(categoryId) {
  const settings = await readSettings();
  settings.permissionCategories = settings.permissionCategories.filter((cat) => cat.id !== categoryId);
  return writeSettings(settings);
}

async function addGroupToCategory(categoryId, groupDn) {
  const settings = await readSettings();
  const category = settings.permissionCategories.find((cat) => cat.id === categoryId);
  if (!category) throw new Error('Nie znaleziono kategorii');
  if (groupDn && !category.groupDns.includes(groupDn)) category.groupDns.push(groupDn);
  await writeSettings(settings);
  return category;
}

async function removeGroupFromCategory(categoryId, groupDn) {
  const settings = await readSettings();
  const category = settings.permissionCategories.find((cat) => cat.id === categoryId);
  if (!category) throw new Error('Nie znaleziono kategorii');
  category.groupDns = category.groupDns.filter((dn) => dn !== groupDn);
  await writeSettings(settings);
  return category;
}

module.exports = {
  readSettings,
  getDefaultNewUserGroups,
  addDefaultNewUserGroup,
  removeDefaultNewUserGroup,
  listPermissionCategories,
  createPermissionCategory,
  deletePermissionCategory,
  addGroupToCategory,
  removeGroupFromCategory
};
