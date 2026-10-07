const searchBtn = document.getElementById('searchBtn');
const results = document.getElementById('results');
const resultsCount = document.getElementById('resultsCount');
const searchInput = document.getElementById('searchInput');
const searchOuDn = document.getElementById('searchOuDn');
const objectBody = document.getElementById('objectBody');
const objectTitle = document.getElementById('objectTitle');
const objectSubtitle = document.getElementById('objectSubtitle');
const objectTitleIcon = document.getElementById('objectTitleIcon');
const loadReportBtn = document.getElementById('loadReportBtn');
const reportResult = document.getElementById('reportResult');
const reportsList = document.getElementById('reportsList');
const statUsers = document.getElementById('statUsers');
const statActiveUsers = document.getElementById('statActiveUsers');
const statActiveUsersWithoutBlockedOu = document.getElementById('statActiveUsersWithoutBlockedOu');
const statGroups = document.getElementById('statGroups');
const statComputers = document.getElementById('statComputers');
const statOus = document.getElementById('statOus');
const statTotal = document.getElementById('statTotal');
const auditRecentList = document.getElementById('auditRecentList');
const loginHistoryList = document.getElementById('loginHistoryList');
const portalActivityFilterForm = document.getElementById('portalActivityFilterForm');
const portalActivityList = document.getElementById('portalActivityList');
const portalActivityPrev = document.getElementById('portalActivityPrev');
const portalActivityNext = document.getElementById('portalActivityNext');
const portalActivityPaginationInfo = document.getElementById('portalActivityPaginationInfo');
const portalActivityAction = document.getElementById('portalActivityAction');
const BLOCKED_ACCOUNTS_OU_DN = 'ou=zablokowane_konta,dc=eskulap,dc=local';
const AD_DOMAIN = document.body.dataset.adDomain || '';

const toast = new bootstrap.Toast(document.getElementById('appToast'));
const objectModal = new bootstrap.Modal(document.getElementById('objectModal'));
const groupSearchModal = new bootstrap.Modal(document.getElementById('groupSearchModal'));
const referenceUserModal = new bootstrap.Modal(document.getElementById('referenceUserModal'));
const copyGroupsModal = new bootstrap.Modal(document.getElementById('copyGroupsModal'));
const addMemberModal = new bootstrap.Modal(document.getElementById('addMemberModal'));
const ouPickerModal = new bootstrap.Modal(document.getElementById('ouPickerModal'));
const softDeleteConfirmModal = new bootstrap.Modal(document.getElementById('softDeleteConfirmModal'));
const softDeleteSuccessModal = new bootstrap.Modal(document.getElementById('softDeleteSuccessModal'));
const unlockAccountModal = new bootstrap.Modal(document.getElementById('unlockAccountModal'));
const certDeleteModal = new bootstrap.Modal(document.getElementById('certDeleteModal'));
const applyObjectChangesBtn = document.getElementById('applyObjectChangesBtn');

const state = {
  currentUserDn: null,
  referenceUserDn: null,
  copyGroups: [],
  selectedOuInputId: null,
  selectedOuDn: null,
  groupPickHandler: null,
  userPickHandler: null,
  newUser: { referenceDn: null, groups: new Set(), loginTouched: false },
  softDeleteTargetDn: null,
  unlockTargetDn: null,
  certificates: [],
  certDelete: null,
  bitlockerKeys: [],
  currentObjectDn: null,
  pendingChanges: null,
  ouTreeCache: new Map(),
  activeReportPage: 'stale-logons',
  searchResults: [],
  searchSort: { key: null, dir: 1 },
  hasSearched: false,
  portalActivityPage: 1
};

function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}"><use href="#i-${name}"/></svg>`;
}

function showToast(message, isError = false) {
  const body = document.getElementById('toastBody');
  const toastEl = document.getElementById('appToast');
  toastEl.classList.toggle('app-toast-error', isError);
  toastEl.querySelector('.app-toast-icon').innerHTML = icon(isError ? 'x' : 'check');
  body.textContent = message;
  toast.show();
}

// Splits a DN into RDNs, honouring backslash-escaped commas.
function splitDn(dn) {
  const parts = [];
  let current = '';
  const str = String(dn || '');
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      current += ch + str[i + 1];
      i += 1;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function rdnValue(rdn) {
  return String(rdn || '').replace(/^[A-Za-z]+=/, '').replace(/\\(.)/g, '$1');
}

function parentDn(dn) {
  return splitDn(dn).slice(1).join(',');
}

// "OU=IT,OU=Szpital,DC=eskulap,DC=local" -> ['eskulap.local', 'Szpital', 'IT']
function dnToPathSegments(dn) {
  const rdns = splitDn(dn);
  const dcs = rdns.filter((r) => /^DC=/i.test(r)).map(rdnValue);
  const rest = rdns.filter((r) => !/^DC=/i.test(r)).map(rdnValue).reverse();
  return [dcs.join('.') || AD_DOMAIN, ...rest].filter(Boolean);
}

function dnToPathHtml(dn, { skipDomain = false } = {}) {
  const segments = dnToPathSegments(dn);
  const list = skipDomain && segments.length > 1 ? segments.slice(1) : segments;
  return list.map((seg) => `<span class="path-seg">${escapeHtml(seg)}</span>`).join('<span class="path-sep">/</span>');
}

function setOuFieldValue(inputId, dn, { silent = false } = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = dn || '';
  document.querySelectorAll(`.ou-field[data-target-input="${inputId}"]`).forEach((field) => {
    const text = field.querySelector('.ou-field-text');
    field.classList.toggle('has-value', Boolean(dn));
    if (!text) return;
    if (dn) {
      text.innerHTML = dnToPathHtml(dn);
      text.title = dn;
    } else {
      text.textContent = text.dataset.placeholder || 'Wybierz OU…';
      text.removeAttribute('title');
    }
  });
  if (!silent) input.dispatchEvent(new Event('change', { bubbles: true }));
}

function getStatus(item) {
  const type = detectType(item);
  if (type !== 'user' && type !== 'computer') return null;
  const disabled = isAccountDisabled(item);
  if (disabled && isInBlockedOu(item)) return { key: 'blocked', label: 'Zablokowane' };
  if (disabled) return { key: 'disabled', label: 'Wyłączone' };
  return { key: 'active', label: 'Aktywne' };
}

function initials(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || 'Błąd API');
  }
  return response.json();
}

function detectType(obj) {
  const cls = Array.isArray(obj.objectClass) ? obj.objectClass.join(',').toLowerCase() : String(obj.objectClass || '').toLowerCase();
  if (cls.includes('organizationalunit') || cls.includes('container')) return 'ou';
  if (cls.includes('computer')) return 'computer';
  if (cls.includes('group')) return 'group';
  return 'user';
}

function getTypeLabel(type) {
  return { user: 'Użytkownik', computer: 'Komputer', group: 'Grupa', ou: 'OU' }[type] || type;
}

const TYPE_ICONS = { user: 'user', computer: 'computer', group: 'group', ou: 'folder' };

function getTypeBadgeHtml(type) {
  const name = TYPE_ICONS[type] || 'info';
  return `<span class="type-badge type-badge-${escapeHtml(type)}" title="${escapeHtml(getTypeLabel(type))}">${icon(name)}</span>`;
}

function getNameFromDn(item) {
  const dn = String(item?.dn || item?.distinguishedName || '');
  if (!dn) return '';
  return dn.split(',')[0].replace(/^[A-Z]+=/i, '').trim();
}

function getDisplayName(item) {
  const type = detectType(item);
  const pick = (...values) => values.find((value) => String(value ?? '').trim() !== '');
  const fromDn = getNameFromDn(item);
  const generic = pick(item.displayName, item.name, item.cn, item.ou, item.sAMAccountName, fromDn);
  if (type === 'group') return pick(item.cn, item.name, item.displayName, item.sAMAccountName, fromDn) || '-';
  if (type === 'ou') return pick(item.ou, item.name, item.displayName, item.cn, item.sAMAccountName, fromDn) || '-';
  return generic || '-';
}

function isAccountDisabled(item) {
  const type = detectType(item);
  if (type !== 'user' && type !== 'computer') return false;
  const flag = Number(item.userAccountControl || 0);
  return (flag & 2) === 2;
}

function isInBlockedOu(item) {
  const dn = String(item?.dn || item?.distinguishedName || '').toLowerCase();
  return dn.includes(BLOCKED_ACCOUNTS_OU_DN);
}

function formatAdDate(raw) {
  if (!raw) return '-';
  const s = String(raw);
  if (/^\d{14}\.0Z$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);
    return d.toLocaleString('pl-PL');
  }
  if (/^\d+$/.test(s) && s.length > 10) {
    const filetime = Number(s);
    const epochMs = Math.floor(filetime / 10000 - 11644473600000);
    if (Number.isFinite(epochMs) && epochMs > 0) {
      return new Date(epochMs).toLocaleString('pl-PL');
    }
  }
  return s;
}

function fileTimeToDate(raw) {
  const s = String(raw || '');
  if (!/^\d+$/.test(s) || s === '0' || s === '9223372036854775807') return null;
  const ms = Math.floor(Number(s) / 10000 - 11644473600000);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

// Most recent of lastLogonTimestamp (replicated, may lag ~14 days) and
// lastLogon (exact, but only from the DC that answered the query).
function getLastLogonDate(item) {
  const dates = [fileTimeToDate(item.lastLogonTimestamp), fileTimeToDate(item.lastLogon)].filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function formatRelative(date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'dziś';
  if (days === 1) return 'wczoraj';
  if (days < 30) return `${days} dni temu`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} mies. temu`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? 'ponad rok temu' : `${years} lat(a) temu`;
}

function lastLogonCellHtml(item) {
  const type = detectType(item);
  if (type !== 'user' && type !== 'computer') return '<span class="text-muted small">—</span>';
  const date = getLastLogonDate(item);
  if (!date) return '<span class="logon-cell logon-never">nigdy</span>';
  const days = (Date.now() - date.getTime()) / 86400000;
  const tone = days > 180 ? 'logon-stale' : days > 30 ? 'logon-old' : 'logon-recent';
  return `<span class="logon-cell ${tone}" title="${escapeHtml(date.toLocaleString('pl-PL'))}"><span class="logon-date">${escapeHtml(date.toLocaleDateString('pl-PL'))}</span><span class="logon-rel">${escapeHtml(formatRelative(date))}</span></span>`;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function parseTruthy(value) {
  const v = String(value ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

function isUacFlagSet(data, flag) {
  const uac = Number(data?.userAccountControl || 0);
  return (uac & flag) === flag;
}

function formatAccountExpiresDate(raw) {
  const s = String(raw || '');
  if (!s || s === '0' || s === '9223372036854775807') return '';
  if (/^\d+$/.test(s)) {
    const filetime = Number(s);
    const epochMs = Math.floor(filetime / 10000 - 11644473600000);
    if (Number.isFinite(epochMs) && epochMs > 0) {
      return new Date(epochMs).toISOString().slice(0, 10);
    }
  }
  return '';
}

function renderResultItem(item) {
  const tr = document.createElement('tr');
  const type = detectType(item);
  const dn = item.dn || item.distinguishedName;
  const name = getDisplayName(item);
  const status = getStatus(item);
  if (status?.key === 'blocked') tr.classList.add('row-blocked');
  else if (status?.key === 'disabled') tr.classList.add('row-disabled');

  const openDetails = () => {
    document.querySelectorAll('#results tr.result-active').forEach((row) => row.classList.remove('result-active'));
    tr.classList.add('result-active');
    openObject(dn, type);
  };

  const login = type === 'user' ? (item.sAMAccountName || '') : '';
  const secondary = login && login.toLowerCase() !== String(name).toLowerCase()
    ? `<span class="font-monospace">${escapeHtml(login)}</span> · ${escapeHtml(getTypeLabel(type))}`
    : escapeHtml(getTypeLabel(type));

  const isLockable = type === 'user' || type === 'computer';
  const lockActionBtn = status?.key === 'blocked'
    ? `<button class="btn-icon btn-icon-success action-unlock" title="Odblokuj konto" aria-label="Odblokuj konto">${icon('unlock')}</button>`
    : (isLockable ? `<button class="btn-icon btn-icon-danger action-toggle" title="Zablokuj konto (soft delete)" aria-label="Zablokuj konto">${icon('lock')}</button>` : '');

  tr.innerHTML = `
    <td>
      <button type="button" class="object-cell object-link">
        ${getTypeBadgeHtml(type)}
        <span class="object-cell-text">
          <span class="object-cell-name">${escapeHtml(name)}</span>
          <span class="object-cell-sub">${secondary}</span>
        </span>
      </button>
    </td>
    <td><div class="path-inline" title="${escapeHtml(dn || '')}">${dn ? dnToPathHtml(parentDn(dn), { skipDomain: true }) : '-'}</div></td>
    <td>${lastLogonCellHtml(item)}</td>
    <td>${status ? `<span class="status-pill status-${status.key}">${escapeHtml(status.label)}</span>` : '<span class="text-muted small">—</span>'}</td>
    <td>
      <div class="d-flex gap-1 justify-content-end">
        <button class="btn-icon action-open" title="Szczegóły" aria-label="Szczegóły">${icon('eye')}</button>
        <button class="btn-icon action-move" title="Przenieś do innego OU" aria-label="Przenieś">${icon('move')}</button>
        ${lockActionBtn}
      </div>
    </td>
  `;

  tr.querySelector('.object-link').addEventListener('click', openDetails);
  tr.querySelector('.action-open').addEventListener('click', openDetails);
  tr.querySelector('.action-move').addEventListener('click', () => openMoveOnly(dn, getDisplayName(item) || dn));
  tr.querySelector('.action-toggle')?.addEventListener('click', () => openSoftDeleteModal(item));
  tr.querySelector('.action-unlock')?.addEventListener('click', () => openUnlockModal(item));
  return tr;
}

function getTypeFilter() {
  return document.querySelector('input[name="typeFilter"]:checked')?.value || 'all';
}

function setResultsMessage(html) {
  results.innerHTML = `<tr><td colspan="5"><div class="empty-state">${html}</div></td></tr>`;
}

function getSearchOptions() {
  return {
    q: searchInput.value.trim(),
    type: getTypeFilter(),
    field: document.getElementById('searchField').value,
    ouDn: searchOuDn.value,
    subtree: document.getElementById('searchSubtree').checked ? '1' : '0',
    status: document.getElementById('searchStatus').value,
    logon: document.getElementById('searchLogon').value,
    days: document.getElementById('searchDays').value,
    limit: document.getElementById('searchLimit').value
  };
}

function updateActiveFiltersBadge() {
  const o = getSearchOptions();
  const active = [o.ouDn, o.field !== 'any', o.subtree === '0', o.status, o.logon, o.limit !== '50'].filter(Boolean).length;
  const badge = document.getElementById('activeFiltersCount');
  badge.textContent = String(active);
  badge.classList.toggle('d-none', !active);
  document.getElementById('searchDaysWrap').classList.toggle('d-none', !['within', 'older'].includes(o.logon));
}

const SORTERS = {
  name: (x) => getDisplayName(x).toLowerCase(),
  path: (x) => dnToPathSegments(parentDn(x.dn || x.distinguishedName)).join('/').toLowerCase(),
  logon: (x) => getLastLogonDate(x)?.getTime() ?? -1,
  status: (x) => ({ active: 0, disabled: 1, blocked: 2 }[getStatus(x)?.key] ?? 3)
};

function renderSearchResults() {
  const { key, dir } = state.searchSort;
  const rows = [...state.searchResults];
  if (key && SORTERS[key]) {
    const get = SORTERS[key];
    rows.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  }
  document.querySelectorAll('#resultsTable th.sortable').forEach((th) => {
    th.classList.toggle('sorted-asc', th.dataset.sort === key && dir === 1);
    th.classList.toggle('sorted-desc', th.dataset.sort === key && dir === -1);
  });
  results.innerHTML = '';
  if (resultsCount) resultsCount.textContent = String(rows.length);
  rows.forEach((row) => results.appendChild(renderResultItem(row)));
  if (!rows.length) setResultsMessage(`${icon('search')}<div>Brak wyników dla podanych kryteriów.</div>`);
}

async function runSearch() {
  const options = getSearchOptions();
  if (!options.q && !options.ouDn && !options.status && !options.logon) {
    showToast('Wpisz frazę lub ustaw filtr (np. OU), aby wyszukać', true);
    searchInput.focus();
    return;
  }
  const truncatedEl = document.getElementById('resultsTruncated');
  try {
    state.hasSearched = true;
    setResultsMessage('<span class="spinner-border spinner-border-sm text-primary"></span><div>Wyszukiwanie…</div>');
    const params = new URLSearchParams(options);
    const data = await api(`/api/search/advanced?${params.toString()}`);
    state.searchResults = data.rows || [];
    truncatedEl.classList.toggle('d-none', !data.truncated);
    truncatedEl.textContent = data.truncated ? `pokazano pierwsze ${data.limit}, zawęź wyszukiwanie lub zwiększ limit w filtrach` : '';
    renderSearchResults();
  } catch (error) {
    truncatedEl.classList.add('d-none');
    setResultsMessage(`<div class="text-danger">${escapeHtml(error.message)}</div>`);
    showToast(error.message, true);
  }
}

function tabsTemplate(tabs) {
  const nav = tabs.map((t, i) => `<li class="nav-item"><button class="nav-link ${i === 0 ? 'active' : ''}" data-bs-toggle="tab" data-bs-target="#${t.id}">${t.title}</button></li>`).join('');
  const content = tabs.map((t, i) => `<div class="tab-pane fade ${i === 0 ? 'show active' : ''} p-2" id="${t.id}">${t.content}</div>`).join('');
  return `<ul class="nav nav-tabs">${nav}</ul><div class="tab-content border border-top-0 rounded-bottom">${content}</div>`;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function inferAdSyntax(attribute, values) {
  const attr = String(attribute || '').toLowerCase();
  if (attr.includes('dn') || attr === 'distinguishedname' || attr === 'memberof' || attr === 'objectcategory') return 'DN';
  if (attr.includes('time') || attr.startsWith('when') || attr.includes('logon') || attr.includes('expires') || attr === 'pwdlastset') return 'Integer8';
  if (attr.includes('count') || attr.includes('control') || attr.includes('code') || attr.includes('type') || attr.includes('groupid') || attr.includes('instance')) return 'Integer';
  if (values.some((value) => value instanceof Uint8Array)) return 'OctetString';
  if (attr === 'objectclass') return 'OID';
  return 'DirectoryString';
}

function formatDevValue(attribute, value) {
  if (value instanceof Uint8Array) return Array.from(value).join(' ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  const str = String(value ?? '');
  if (/(time|when|logon|expires|pwdlastset)/i.test(attribute)) return formatAdDate(str);
  return str;
}

function devTemplate(data) {
  const rows = Object.entries(data || {})
    .filter(([key]) => key !== 'controls')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([attribute, rawValue]) => {
      const values = toArray(rawValue);
      const syntax = inferAdSyntax(attribute, values);
      const count = values.length || 1;
      const printableValue = values.length ? values.map((value) => formatDevValue(attribute, value)).join('; ') : '-';
      return `
        <tr>
          <td class="text-nowrap">${escapeHtml(attribute)}</td>
          <td class="text-nowrap">${escapeHtml(syntax)}</td>
          <td class="text-end">${count}</td>
          <td class="font-monospace small">${escapeHtml(printableValue)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="table-responsive">
      <table class="table table-sm table-striped table-hover align-middle mb-0">
        <thead>
          <tr>
            <th>Attribute</th>
            <th>Syntax</th>
            <th class="text-end">Count</th>
            <th>Value(s)</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4" class="text-muted">Brak danych</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function dataTableTemplate(data) {
  const rows = [
    ['DN', data.dn],
    ['CN', data.cn],
    ['SN', data.sn],
    ['givenName', data.givenName],
    ['distinguishedName', data.distinguishedName],
    ['displayName', data.displayName],
    ['lastLogon', formatAdDate(data.lastLogonTimestamp || data.lastLogon)],
    ['whenCreated', formatAdDate(data.whenCreated)]
  ];
  return `<div class="d-grid gap-2">${rows.map(([k, v]) => `<div class="input-group input-group-sm"><span class="input-group-text">${k}</span><input class="form-control" readonly value="${escapeHtml(v || '-')}" /></div>`).join('')}</div>`;
}

function memberOfTemplate(data) {
  const groups = Array.isArray(data.memberOf) ? data.memberOf : [];
  const userDn = data.distinguishedName || data.dn;
  return `
    <div class="mb-2 group-member-list" id="memberOfList" data-userdn="${escapeHtml(userDn)}">
      ${groups.map((g) => renderPendingMemberLine(g, false)).join('') || '<span class="text-muted">Brak grup</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddGroupModal" data-userdn="${escapeHtml(userDn)}">${icon('plus')} Dodaj grupę</button>
      <button class="btn btn-outline-secondary btn-sm" id="openReferenceModal" data-userdn="${escapeHtml(userDn)}">${icon('copy')} Kopiuj z innego użytkownika</button>
    </div>
  `;
}

function membersTemplate(data) {
  const members = Array.isArray(data.member) ? data.member : (data.member ? [data.member] : []);
  const groupDn = data.distinguishedName || data.dn;
  return `
    <div class="mb-2 group-member-list" id="membersList" data-groupdn="${escapeHtml(groupDn)}">
      ${members.map((m) => renderPendingMemberEntry(m, false)).join('') || '<span class="text-muted">Brak członków</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddMemberModal" data-groupdn="${escapeHtml(groupDn)}">${icon('plus')} Dodaj członka</button>
    </div>
  `;
}

function dnChipContent(dn) {
  return `<span class="dn-chip-name">${escapeHtml(dnLabel(dn))}</span><span class="dn-chip-path">${dnToPathHtml(parentDn(dn), { skipDomain: true })}</span>`;
}

function renderPendingMemberEntry(memberDn, pendingAdd = false) {
  return `<div class="member-of-line ${pendingAdd ? 'pending-added' : ''}" data-memberdn="${escapeHtml(memberDn)}"><span class="group-badge" title="${escapeHtml(memberDn)}">${dnChipContent(memberDn)}</span><button type="button" class="btn-icon btn-icon-sm remove-member-btn" aria-label="Usuń" title="Usuń" data-memberdn="${escapeHtml(memberDn)}">${icon('x')}</button></div>`;
}

function userSettingsTemplate(data) {
  const mustChangePwd = String(data.pwdLastSet || '') === '0';
  const passwordNeverExpires = isUacFlagSet(data, 0x10000);
  const accountDisabled = isUacFlagSet(data, 0x0002);
  const smartcardRequired = isUacFlagSet(data, 0x40000);
  const userCannotChangePassword = isUacFlagSet(data, 0x0040);
  const accountExpiresDate = formatAccountExpiresDate(data.accountExpires);
  const expiresNever = !accountExpiresDate;

  return `
    <form id="userSettingsForm" class="d-grid gap-3">
      <div><label class="form-label">Adres email</label><input class="form-control" name="mail" value="${escapeHtml(data.mail || '')}" /></div>
      <div>
        <div class="fw-semibold mb-2">Opcje konta</div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="mustChangePasswordAtNextLogon" ${mustChangePwd ? 'checked' : ''}><label class="form-check-label">Użytkownik musi zmienić hasło przy następnym logowaniu</label></div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="userCannotChangePassword" ${userCannotChangePassword ? 'checked' : ''}><label class="form-check-label">Użytkownik nie może zmienić hasła</label></div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="passwordNeverExpires" ${passwordNeverExpires ? 'checked' : ''}><label class="form-check-label">Hasło nigdy nie wygasa</label></div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="accountDisabled" ${accountDisabled ? 'checked' : ''}><label class="form-check-label">Konto jest wyłączone</label></div>
        <div class="form-check"><input class="form-check-input" type="checkbox" name="smartcardRequired" ${smartcardRequired ? 'checked' : ''}><label class="form-check-label">Logowanie interakcyjne wymaga karty inteligentnej</label></div>
      </div>
      <div>
        <div class="fw-semibold mb-2">Wygasanie konta</div>
        <div class="form-check"><input class="form-check-input" type="radio" name="accountExpiresMode" value="never" ${expiresNever ? 'checked' : ''}><label class="form-check-label">Nigdy</label></div>
        <div class="form-check"><input class="form-check-input" type="radio" name="accountExpiresMode" value="date" ${expiresNever ? '' : 'checked'}><label class="form-check-label">Z końcem</label></div>
        <input class="form-control form-control-sm mt-1" type="date" name="accountExpiresDate" value="${escapeHtml(accountExpiresDate)}" ${expiresNever ? 'disabled' : ''} />
      </div>
      <div>
        <div class="fw-semibold mb-2">Sekcja profilu użytkownika</div>
        <div class="mb-2"><label class="form-label">Ścieżka profilu</label><input class="form-control" name="profilePath" value="${escapeHtml(data.profilePath || '')}" /></div>
        <div><label class="form-label">Ścieżka logowania</label><input class="form-control" name="scriptPath" value="${escapeHtml(data.scriptPath || '')}" /></div>
      </div>
      <div>
        <div class="fw-semibold mb-2">Folder macierzysty</div>
        <div class="mb-2"><label class="form-label">Ścieżka lokalna</label><input class="form-control" name="homeDirectory" value="${escapeHtml(data.homeDirectory || '')}" /></div>
        <div>
          <label class="form-label">Podłącz (litera) do</label>
          <select class="form-select" name="homeDrive">
            <option value="">— wybierz —</option>
            ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => {
              const value = `${letter}:`;
              return `<option value="${value}" ${String(data.homeDrive || '').toUpperCase() === value ? 'selected' : ''}>${value}</option>`;
            }).join('')}
          </select>
        </div>
      </div>
      <div><button type="submit" class="btn btn-primary btn-sm">Zapisz ustawienia</button></div>
    </form>
  `;
}

function userDataTemplate(data) {
  const rows = [
    ['Imię', data.givenName],
    ['Nazwisko', data.sn],
    ['Login', data.sAMAccountName],
    ['Email', data.mail],
    ['Nazwa wyświetlana', data.displayName],
    ['DN', data.distinguishedName || data.dn],
    ['Ostatnie logowanie', formatAdDate(data.lastLogonTimestamp || data.lastLogon)],
    ['Data utworzenia', formatAdDate(data.whenCreated)]
  ];
  return `<div class="d-grid gap-2">${rows.map(([label, value]) => `<div class="input-group input-group-sm"><span class="input-group-text">${escapeHtml(label)}</span><input class="form-control" readonly value="${escapeHtml(value || '-')}" /></div>`).join('')}</div>`;
}

function certificatesTemplate(dn) {
  return `
    <div class="d-flex justify-content-between align-items-center mb-2">
      <div class="small text-muted">Certyfikaty zapisane na koncie w AD (atrybut <code>userCertificate</code>), np. certyfikaty kart inteligentnych.</div>
      <button type="button" class="btn btn-sm btn-outline-secondary" id="reloadCertificatesBtn">${icon('refresh')} Odśwież</button>
    </div>
    <div class="user-certificates-list" data-dn="${escapeHtml(dn || '')}"><div class="lookup-empty"><span class="spinner-border spinner-border-sm text-primary"></span> Ładowanie certyfikatów…</div></div>
  `;
}

function userTemplate(data) {
  return tabsTemplate([
    { id: 'u-data', title: 'Dane', content: userDataTemplate(data) },
    { id: 'u-settings', title: 'Ustawienia', content: userSettingsTemplate(data) },
    { id: 'u-memberof', title: 'Członek grup', content: memberOfTemplate(data) },
    { id: 'u-certs', title: 'Certyfikaty', content: certificatesTemplate(data.distinguishedName || data.dn) },
    { id: 'u-logs', title: 'Logi', content: auditLogsTemplate(data.distinguishedName || data.dn, 'user') },
    { id: 'u-dev', title: 'DEV', content: devTemplate(data) }
  ]);
}

function computerAccountNote(data) {
  const sam = data.sAMAccountName || '';
  return `
    <div class="alert alert-info small mt-3 mb-0">
      <strong>Nazwa konta komputera (sAMAccountName):</strong> <code>${escapeHtml(sam || '-')}</code>
      <div class="mt-1">
        Znak <code>$</code> na końcu to standardowy zapis Active Directory dla kont maszynowych
        (odróżnia konto komputera od kont użytkowników o tej samej nazwie) — to nie błąd.
        Sama nazwa NetBIOS komputera (pole <code>name</code>/<code>cn</code>, widoczne np. we właściwościach
        systemu Windows) pozostaje bez znaku <code>$</code>.
      </div>
    </div>
  `;
}

function bitlockerTemplate(dn) {
  return `
    <div class="d-flex gap-2 mb-2">
      <button type="button" class="btn btn-sm btn-outline-secondary" id="copyAllBitlockerBtn">Kopiuj wszystkie klucze</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" id="exportBitlockerPdfBtn">Eksportuj do PDF</button>
    </div>
    <div class="bitlocker-keys-list" data-dn="${escapeHtml(dn || '')}">Ładowanie kluczy BitLocker…</div>
  `;
}

function computerTemplate(data) {
  return tabsTemplate([
    { id: 'c-data', title: 'Dane komputera', content: dataTableTemplate(data) + computerAccountNote(data) },
    { id: 'c-bitlocker', title: 'BitLocker', content: bitlockerTemplate(data.distinguishedName || data.dn) },
    { id: 'c-memberof', title: 'Członek grup', content: memberOfTemplate(data) },
    { id: 'c-logs', title: 'Logi', content: auditLogsTemplate(data.distinguishedName || data.dn, 'computer') },
    { id: 'c-dev', title: 'DEV', content: devTemplate(data) }
  ]);
}

function groupTemplate(data) {
  return tabsTemplate([
    { id: 'g-data', title: 'Dane', content: dataTableTemplate(data) },
    { id: 'g-members', title: 'Członkowie grupy', content: membersTemplate(data) },
    { id: 'g-memberof', title: 'Członek grup', content: memberOfTemplate(data) },
    { id: 'g-logs', title: 'Logi', content: auditLogsTemplate(data.distinguishedName || data.dn, 'group') },
    { id: 'g-dev', title: 'DEV', content: devTemplate(data) }
  ]);
}

function ouTemplate(data) {
  return tabsTemplate([
    { id: 'o-data', title: 'Dane obiektu', content: dataTableTemplate(data) },
    { id: 'o-logs', title: 'Logi', content: auditLogsTemplate(data.distinguishedName || data.dn, 'ou') },
    { id: 'o-dev', title: 'DEV', content: devTemplate(data) }
  ]);
}

function auditLogsTemplate(dn, type) {
  return `
    <div class="small text-muted mb-2">Historia zmian i działań z portalu dla obiektu typu ${escapeHtml(type)}.</div>
    <div class="audit-object-logs" data-dn="${escapeHtml(dn || '')}">Ładowanie logów…</div>
  `;
}

function dnLabel(dn) {
  const s = String(dn || '');
  if (!s) return '';
  const first = s.split(',')[0] || s;
  return first.replace(/^[A-Za-z]+=/, '').trim() || s;
}

function formatDnList(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return '<span class="text-muted">—</span>';
  return `<ul class="mb-0 ps-3">${arr.map((dn) => `<li class="small" title="${escapeHtml(dn)}">${escapeHtml(dnLabel(dn))}</li>`).join('')}</ul>`;
}

function formatAuditDetails(event) {
  const details = event.details || {};
  const action = event.action;
  const rows = [];

  if (action === 'user_groups_update' || action === 'group_members_update') {
    const label = action === 'group_members_update' ? 'członka(ów)' : 'grup(y)';
    if ((details.added || []).length) {
      rows.push(`<div class="mt-1"><span class="text-success fw-semibold">+ Dodano ${label}:</span>${formatDnList(details.added)}</div>`);
    }
    if ((details.removed || []).length) {
      rows.push(`<div class="mt-1"><span class="text-danger fw-semibold">− Usunięto ${label}:</span>${formatDnList(details.removed)}</div>`);
    }
    if (!(details.added || []).length && !(details.removed || []).length) {
      rows.push('<div class="mt-1 text-muted">Brak zmian w listach.</div>');
    }
  } else if (action === 'user_groups_copy') {
    if ((details.copiedGroups || []).length) {
      rows.push(`<div class="mt-1"><span class="fw-semibold">Skopiowane grupy:</span>${formatDnList(details.copiedGroups)}</div>`);
    }
  } else if (action === 'account_enabled_toggle') {
    rows.push(`<div class="mt-1">Nowy stan konta: <strong>${details.enabled ? 'włączone' : 'wyłączone'}</strong></div>`);
  } else if (action === 'account_unlock') {
    rows.push('<div class="mt-1">Konto odblokowane (włączone)' + (event.targetDn ? ` i przeniesione do <code class="small">${escapeHtml(event.targetDn)}</code>` : '') + '</div>');
  } else if (action === 'account_soft_delete') {
    if (event.targetDn) rows.push(`<div class="mt-1">Wyłączono i przeniesiono do: <code class="small">${escapeHtml(event.targetDn)}</code></div>`);
    if (details.groupsBefore) {
      rows.push(`<div class="mt-1"><span class="fw-semibold">Grupy przed usunięciem (${details.groupsBefore.length}):</span>${formatDnList(details.groupsBefore)}</div>`);
    }
    if ((details.failedGroups || []).length) {
      rows.push(`<div class="mt-1"><span class="text-danger fw-semibold">Nie udało się usunąć z:</span>${formatDnList(details.failedGroups.map((f) => f.groupDn))}</div>`);
    }
  } else if (action === 'user_certificate_delete') {
    rows.push(`<div class="mt-1"><span class="fw-semibold">Certyfikat:</span> ${escapeHtml(details.subject || details.subjectCn || '-')}${details.thumbprint ? ` · odcisk <code class="small">${escapeHtml(details.thumbprint)}</code>` : ''}${details.serialNumber ? ` · nr <code class="small">${escapeHtml(details.serialNumber)}</code>` : ''}</div>`);
  } else if (action === 'object_move') {
    if (event.targetDn) rows.push(`<div class="mt-1">Przeniesiono do: <code class="small">${escapeHtml(event.targetDn)}</code></div>`);
  } else if (action === 'user_settings_update') {
    if ((details.changedKeys || []).length) {
      rows.push(`<div class="mt-1"><span class="fw-semibold">Zmienione pola:</span> ${details.changedKeys.map((k) => `<code class="small">${escapeHtml(k)}</code>`).join(' ')}</div>`);
    }
  } else if (action === 'group_create') {
    if (details.payload) {
      rows.push(`<div class="mt-1"><span class="fw-semibold">Nazwa:</span> ${escapeHtml(details.payload.name || '-')} · <span class="fw-semibold">sAMAccountName:</span> ${escapeHtml(details.payload.samAccountName || '-')}</div>`);
    }
  } else if (action === 'user_create') {
    if (details.login) rows.push(`<div class="mt-1"><span class="fw-semibold">Login:</span> ${escapeHtml(details.login)}</div>`);
  } else if (action === 'search') {
    rows.push(`<div class="mt-1">Zapytanie: <code>${escapeHtml(details.query || '')}</code> · typ: ${escapeHtml(details.type || '-')} · wyników: ${details.results ?? '-'}</div>`);
  } else if (details && Object.keys(details).length) {
    rows.push(`<div class="mt-1"><code class="small">${escapeHtml(JSON.stringify(details))}</code></div>`);
  }

  return rows.join('');
}

function formatAuditEventLine(event) {
  const timestamp = formatAdDate(event.timestamp);
  const actor = event.actorDisplayName || event.actorLogin || 'nieznany';
  const action = event.action || 'akcja';
  const statusClass = event.status === 'success' ? 'text-bg-success' : 'text-bg-danger';
  const message = event.message || '-';
  const detailsHtml = formatAuditDetails(event);
  return `
    <div class="border rounded p-2 mb-2">
      <div class="d-flex align-items-center justify-content-between mb-1">
        <div><strong>${escapeHtml(actor)}</strong> <span class="text-muted">(${escapeHtml(event.actorLogin || '-')})</span></div>
        <span class="badge ${statusClass}">${escapeHtml(event.status || '-')}</span>
      </div>
      <div class="small"><code>${escapeHtml(action)}</code> · ${escapeHtml(timestamp)}</div>
      <div class="small mt-1">${escapeHtml(message)}</div>
      <div class="small text-muted mt-1">${escapeHtml(event.scopeDn || event.targetDn || '')}</div>
      ${detailsHtml ? `<div class="audit-details">${detailsHtml}</div>` : ''}
    </div>
  `;
}

async function loadObjectAuditLogs(objectDn) {
  const holder = document.querySelector('.audit-object-logs');
  if (!holder || !objectDn) return;
  try {
    const rows = await api(`/api/audit/object-logs?dn=${encodeURIComponent(objectDn)}&limit=200`);
    holder.innerHTML = rows.length
      ? rows.map((event) => formatAuditEventLine(event)).join('')
      : '<div class="text-muted small">Brak logów dla tego obiektu.</div>';
  } catch (error) {
    holder.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // spadamy do awaryjnego rozwiązania poniżej
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // brak wsparcia — nic więcej nie możemy zrobić
  }
  document.body.removeChild(textarea);
}

function exportBitlockerKeysToPdf(dn, keys) {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text('Klucze odzyskiwania BitLocker', 14, 16);
    doc.setFontSize(10);
    doc.text(`Komputer: ${dn || '-'}`, 14, 24);
    doc.text(`Wygenerowano: ${new Date().toLocaleString('pl-PL')}`, 14, 30);

    let y = 42;
    keys.forEach((key, idx) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      doc.setFont(undefined, 'bold');
      doc.text(`${idx + 1}. ${key.name || '-'}`, 14, y);
      doc.setFont(undefined, 'normal');
      y += 6;
      doc.text(`Klucz: ${key.recoveryPassword || '-'}`, 14, y);
      y += 6;
      doc.text(`Utworzono: ${formatAdDate(key.whenCreated)}`, 14, y);
      y += 10;
    });

    const fileSafeDn = (dnLabel(dn) || 'komputer').replace(/[^a-z0-9_-]+/gi, '_');
    doc.save(`bitlocker-${fileSafeDn}.pdf`);
  } catch (error) {
    showToast(`Błąd eksportu PDF: ${error.message}`, true);
  }
}

async function loadBitlockerKeys(dn) {
  const holder = document.querySelector('.bitlocker-keys-list');
  if (!holder || !dn) return;
  try {
    const rows = await api(`/api/computer/bitlocker?dn=${encodeURIComponent(dn)}`);
    state.bitlockerKeys = rows;
    holder.innerHTML = rows.length
      ? `
        <div class="table-responsive">
          <table class="table table-sm table-striped align-middle mb-0">
            <thead>
              <tr><th>Nazwa (GUID)</th><th>Klucz odzyskiwania</th><th>Data utworzenia</th><th></th></tr>
            </thead>
            <tbody>
              ${rows.map((row, idx) => `
                <tr>
                  <td class="small text-break">${escapeHtml(row.name || '-')}</td>
                  <td class="font-monospace small text-break">${escapeHtml(row.recoveryPassword || '-')}</td>
                  <td class="small">${escapeHtml(formatAdDate(row.whenCreated))}</td>
                  <td><button type="button" class="btn btn-sm btn-outline-secondary copy-bitlocker-key" data-index="${idx}">Kopiuj</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
      : '<div class="text-muted small">Brak zapisanych kluczy BitLocker dla tego komputera.</div>';

    holder.querySelectorAll('.copy-bitlocker-key').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = state.bitlockerKeys[Number(btn.dataset.index)];
        await copyTextToClipboard(row?.recoveryPassword || '');
        showToast('Skopiowano klucz do schowka');
      });
    });
  } catch (error) {
    holder.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

function formatCertDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('pl-PL');
}

function certStatusHtml(cert) {
  if (cert.parseError) return '<span class="status-pill status-disabled">Nieczytelny</span>';
  if (cert.expired) return '<span class="status-pill status-blocked">Wygasł</span>';
  if (cert.notYetValid) return '<span class="status-pill status-disabled">Jeszcze nieważny</span>';
  return '<span class="status-pill status-active">Ważny</span>';
}

async function loadUserCertificates(dn) {
  const holder = document.querySelector('.user-certificates-list');
  if (!holder || !dn) return;
  try {
    const rows = await api(`/api/user/certificates?dn=${encodeURIComponent(dn)}`);
    state.certificates = rows;
    holder.innerHTML = rows.length
      ? `
        <div class="table-responsive report-table-wrap">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead>
              <tr><th>Wystawiony dla</th><th>Wystawca</th><th>Ważność</th><th>Status</th><th>Odcisk palca (SHA-1)</th><th></th></tr>
            </thead>
            <tbody>
              ${rows.map((row, idx) => `
                <tr>
                  <td class="small text-break"><span class="fw-semibold">${escapeHtml(row.subjectCn || row.subject || '-')}</span>${row.subjectAltName ? `<div class="text-muted">${escapeHtml(row.subjectAltName)}</div>` : ''}</td>
                  <td class="small text-break">${escapeHtml(row.issuerCn || row.issuer || '-')}</td>
                  <td class="small text-nowrap">${escapeHtml(formatCertDate(row.validFrom))} – ${escapeHtml(formatCertDate(row.validTo))}</td>
                  <td>${certStatusHtml(row)}</td>
                  <td class="font-monospace small text-break">${escapeHtml(row.thumbprint || '-')}</td>
                  <td class="text-end"><button type="button" class="btn-icon btn-icon-danger delete-certificate-btn" data-index="${idx}" title="Usuń certyfikat" aria-label="Usuń certyfikat">${icon('x')}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
      : `<div class="empty-state">${icon('key')}<div>Brak certyfikatów przypisanych do tego konta.</div></div>`;

    holder.querySelectorAll('.delete-certificate-btn').forEach((btn) => {
      btn.addEventListener('click', () => openCertDeleteModal(dn, state.certificates[Number(btn.dataset.index)]));
    });
  } catch (error) {
    holder.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

function openCertDeleteModal(userDn, cert) {
  if (!cert) return;
  state.certDelete = { userDn, cert };
  const rows = [
    ['Wystawiony dla', cert.subjectCn || cert.subject],
    ['Wystawca', cert.issuerCn || cert.issuer],
    ['Ważny do', formatCertDate(cert.validTo)],
    ['Numer seryjny', cert.serialNumber],
    ['Odcisk palca', cert.thumbprint]
  ];
  document.getElementById('certDeleteSummary').innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="${k === 'Odcisk palca' || k === 'Numer seryjny' ? 'font-monospace' : ''}">${escapeHtml(v || '-')}</dd>`)
    .join('');
  certDeleteModal.show();
}

document.getElementById('confirmCertDeleteBtn').addEventListener('click', async () => {
  const pending = state.certDelete;
  if (!pending) return;
  const btn = document.getElementById('confirmCertDeleteBtn');
  try {
    btn.disabled = true;
    await api('/api/user/certificates/delete', {
      method: 'POST',
      body: JSON.stringify({ userDn: pending.userDn, fingerprint256: pending.cert.fingerprint256 })
    });
    certDeleteModal.hide();
    showToast('Certyfikat usunięty z konta');
    await loadUserCertificates(pending.userDn);
    await loadObjectAuditLogs(pending.userDn);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
    state.certDelete = null;
  }
});

async function loadGlobalAuditWidgets() {
  try {
    const loginRows = await api('/api/audit/login-history?limit=30');
    if (loginHistoryList) {
      loginHistoryList.innerHTML = loginRows.length
        ? loginRows.map((event) => formatAuditEventLine(event)).join('')
        : '<div class="text-muted">Brak logowań.</div>';
    }
  } catch (error) {
    if (loginHistoryList) loginHistoryList.innerHTML = `<div class="text-danger">${escapeHtml(error.message)}</div>`;
  }
}

function switchReportPage(reportId) {
  state.activeReportPage = reportId;
  document.querySelectorAll('.report-page').forEach((page) => {
    page.classList.toggle('d-none', page.dataset.reportPage !== reportId);
  });
  document.querySelectorAll('.report-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.report === reportId);
  });
}

async function loadPortalActivityReport(page = 1) {
  if (!portalActivityList) return;
  try {
    state.portalActivityPage = Math.max(page, 1);
    const q = document.getElementById('portalActivitySearch')?.value || '';
    const from = document.getElementById('portalActivityFrom')?.value || '';
    const to = document.getElementById('portalActivityTo')?.value || '';
    const action = portalActivityAction?.value || '';
    const status = document.getElementById('portalActivityStatus')?.value || '';
    const pageSize = Number(document.getElementById('portalActivityPageSize')?.value || 20);
    const params = new URLSearchParams({
      q,
      from,
      to,
      action,
      status,
      page: String(state.portalActivityPage),
      pageSize: String(pageSize)
    });
    const data = await api(`/api/reports/portal-activity?${params.toString()}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    portalActivityList.innerHTML = rows.length
      ? rows.map((event) => formatAuditEventLine(event)).join('')
      : '<div class="text-muted">Brak zdarzeń dla podanych filtrów.</div>';

    const pagination = data.pagination || {};
    const totalPages = Number(pagination.totalPages || 1);
    const currentPage = Number(pagination.page || 1);
    if (portalActivityPaginationInfo) {
      portalActivityPaginationInfo.textContent = `Strona ${currentPage}/${totalPages} · Rekordy: ${pagination.total || 0}`;
    }
    if (portalActivityPrev) portalActivityPrev.disabled = currentPage <= 1;
    if (portalActivityNext) portalActivityNext.disabled = currentPage >= totalPages;
  } catch (error) {
    portalActivityList.innerHTML = `<div class="text-danger">${escapeHtml(error.message)}</div>`;
  }
}

async function initPortalActivityActions() {
  if (!portalActivityAction) return;
  try {
    const rows = await api('/api/audit/recent?limit=500');
    const actions = [...new Set((rows || []).map((row) => row.action).filter(Boolean))];
    actions.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      portalActivityAction.appendChild(option);
    });
  } catch {
    // ignorujemy; formularz nadal działa bez listy akcji
  }
}

function renderPendingMemberLine(groupDn, pendingAdd = false) {
  return `<div class="member-of-line ${pendingAdd ? 'pending-added' : ''}" data-groupdn="${escapeHtml(groupDn)}"><span class="group-badge" title="${escapeHtml(groupDn)}">${dnChipContent(groupDn)}</span><button type="button" class="btn-icon btn-icon-sm remove-group-btn" aria-label="Usuń" title="Usuń" data-groupdn="${escapeHtml(groupDn)}">${icon('x')}</button></div>`;
}

function moveTemplate(objectDn) {
  return `
    <div class="mb-3">
      <div class="small text-muted mb-1">Obecna lokalizacja</div>
      <div class="path-inline">${dnToPathHtml(parentDn(objectDn))}</div>
    </div>
    <label class="form-label">Nowa lokalizacja</label>
    <div class="ou-field" data-target-input="newOuDn">
      <input type="hidden" id="newOuDn" />
      <button type="button" class="ou-field-btn pick-ou-btn" data-target-input="newOuDn">
        ${icon('folder')}
        <span class="ou-field-text" data-placeholder="Wybierz jednostkę organizacyjną…">Wybierz jednostkę organizacyjną…</span>
        ${icon('chevron-down', 'ou-field-caret')}
      </button>
    </div>
    <div class="field-hint">Zmiana zostanie wykonana po kliknięciu „Zastosuj zmiany”.</div>
    <input type="hidden" id="moveObjectDn" value="${escapeHtml(objectDn)}" />
  `;
}

function setObjectHeader(title, type, subtitleHtml = '') {
  objectTitle.textContent = title;
  if (objectSubtitle) objectSubtitle.innerHTML = subtitleHtml;
  if (objectTitleIcon) {
    objectTitleIcon.className = `modal-title-icon type-tone-${type || 'none'}`;
    objectTitleIcon.innerHTML = icon(TYPE_ICONS[type] || 'move');
  }
}

async function openObject(dn, typeHint) {
  try {
    const data = await api(`/api/object?dn=${encodeURIComponent(dn)}`);
    const type = typeHint || detectType(data);
    const objDn = data.distinguishedName || data.dn || dn;
    setObjectHeader(getDisplayName(data), type, `${escapeHtml(getTypeLabel(type))} · ${dnToPathHtml(parentDn(objDn))}`);
    objectBody.innerHTML = type === 'computer'
      ? computerTemplate(data)
      : type === 'group'
        ? groupTemplate(data)
        : type === 'ou'
          ? ouTemplate(data)
          : userTemplate(data);
    state.currentObjectDn = data.distinguishedName || data.dn || dn;
    state.pendingChanges = { addGroups: new Set(), removeGroups: new Set(), addMembers: new Set(), removeMembers: new Set(), moveTargetDn: null };
    applyObjectChangesBtn.classList.remove('d-none');
    bindModalActions();
    await loadObjectAuditLogs(state.currentObjectDn);
    if (type === 'computer') await loadBitlockerKeys(state.currentObjectDn);
    if (type === 'user') await loadUserCertificates(state.currentObjectDn);
    objectModal.show();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openMoveOnly(dn, label) {
  setObjectHeader(`Przenieś: ${label}`, null, 'Przeniesienie obiektu do innej jednostki organizacyjnej');
  objectBody.innerHTML = moveTemplate(dn);
  state.currentObjectDn = dn;
  state.pendingChanges = { addGroups: new Set(), removeGroups: new Set(), moveTargetDn: null };
  applyObjectChangesBtn.classList.remove('d-none');
  bindModalActions();
  objectModal.show();
}

function openSoftDeleteModal(item) {
  const dn = item?.dn || item?.distinguishedName;
  if (!dn) {
    showToast('Brak DN obiektu do zablokowania', true);
    return;
  }
  state.softDeleteTargetDn = dn;
  const target = document.getElementById('softDeleteTargetDn');
  if (target) target.textContent = dn;
  const list = document.getElementById('softDeleteGroupsList');
  const count = document.getElementById('softDeleteGroupsCount');
  count.textContent = '…';
  list.innerHTML = '<div class="lookup-empty py-2"><span class="spinner-border spinner-border-sm text-primary"></span> Pobieranie grup…</div>';
  softDeleteConfirmModal.show();
  api(`/api/object?dn=${encodeURIComponent(dn)}`)
    .then((data) => {
      if (state.softDeleteTargetDn !== dn) return;
      const groups = toArray(data.memberOf).map(String);
      count.textContent = String(groups.length);
      list.innerHTML = groups.length
        ? groups.map((g) => `<div class="member-of-line"><span class="group-badge" title="${escapeHtml(g)}">${dnChipContent(g)}</span></div>`).join('')
        : '<div class="chip-empty">Konto nie należy do żadnej grupy (poza grupą podstawową).</div>';
    })
    .catch((error) => {
      if (state.softDeleteTargetDn !== dn) return;
      count.textContent = '?';
      list.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
    });
}

function openUnlockModal(item) {
  const dn = item?.dn || item?.distinguishedName;
  if (!dn) {
    showToast('Brak DN obiektu do odblokowania', true);
    return;
  }
  state.unlockTargetDn = dn;
  const label = document.getElementById('unlockTargetDnLabel');
  if (label) label.textContent = dn;
  setOuFieldValue('unlockTargetOuDn', '', { silent: true });
  unlockAccountModal.show();
}

function renderLookupItem(container, item, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const type = detectType(item);
  const dn = item.dn || item.distinguishedName || '';
  const status = getStatus(item);
  const login = type === 'user' && item.sAMAccountName ? `<span class="font-monospace">${escapeHtml(item.sAMAccountName)}</span> · ` : '';
  btn.className = 'lookup-item';
  btn.innerHTML = `
    ${getTypeBadgeHtml(type)}
    <span class="lookup-item-text">
      <span class="lookup-item-name">${escapeHtml(getDisplayName(item))}</span>
      <span class="lookup-item-sub" title="${escapeHtml(dn)}">${login}${dnToPathHtml(parentDn(dn), { skipDomain: true })}</span>
    </span>
    ${status && status.key !== 'active' ? `<span class="status-pill status-${status.key}">${escapeHtml(status.label)}</span>` : ''}
    ${icon('chevron-right', 'lookup-item-caret')}
  `;
  btn.addEventListener('click', () => onPick(item));
  container.appendChild(btn);
}

function setLookupMessage(container, html) {
  container.innerHTML = `<div class="lookup-empty">${html}</div>`;
}

// Debounced type-ahead for the lookup modals; ignores stale responses.
function bindLookup(input, container, fetchRows, onPick) {
  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim();
    const mySeq = ++seq;
    if (q.length < 2) {
      setLookupMessage(container, 'Wpisz co najmniej 2 znaki.');
      return;
    }
    setLookupMessage(container, '<span class="spinner-border spinner-border-sm text-primary"></span> Wyszukiwanie…');
    try {
      const rows = await fetchRows(q);
      if (mySeq !== seq) return;
      container.innerHTML = '';
      if (!rows.length) {
        setLookupMessage(container, 'Brak wyników.');
        return;
      }
      rows.forEach((row) => renderLookupItem(container, row, onPick));
    } catch (error) {
      if (mySeq === seq) setLookupMessage(container, `<span class="text-danger">${escapeHtml(error.message)}</span>`);
    }
  }, 250);
  input.addEventListener('input', run);
  return run;
}

function bindModalActions() {
  const copyAllBitlockerBtn = document.getElementById('copyAllBitlockerBtn');
  if (copyAllBitlockerBtn && !copyAllBitlockerBtn.dataset.bound) {
    copyAllBitlockerBtn.dataset.bound = '1';
    copyAllBitlockerBtn.addEventListener('click', async () => {
      const keys = state.bitlockerKeys || [];
      if (!keys.length) {
        showToast('Brak kluczy do skopiowania', true);
        return;
      }
      const text = keys.map((k) => `${k.name || '-'}: ${k.recoveryPassword || '-'}`).join('\n');
      await copyTextToClipboard(text);
      showToast('Skopiowano wszystkie klucze do schowka');
    });
  }

  const reloadCertificatesBtn = document.getElementById('reloadCertificatesBtn');
  if (reloadCertificatesBtn && !reloadCertificatesBtn.dataset.bound) {
    reloadCertificatesBtn.dataset.bound = '1';
    reloadCertificatesBtn.addEventListener('click', () => loadUserCertificates(state.currentObjectDn));
  }

  const exportBitlockerPdfBtn = document.getElementById('exportBitlockerPdfBtn');
  if (exportBitlockerPdfBtn && !exportBitlockerPdfBtn.dataset.bound) {
    exportBitlockerPdfBtn.dataset.bound = '1';
    exportBitlockerPdfBtn.addEventListener('click', () => {
      const keys = state.bitlockerKeys || [];
      if (!keys.length) {
        showToast('Brak kluczy do eksportu', true);
        return;
      }
      exportBitlockerKeysToPdf(state.currentObjectDn, keys);
    });
  }

  document.getElementById('openAddGroupModal')?.addEventListener('click', () => {
    state.currentUserDn = document.getElementById('openAddGroupModal').dataset.userdn;
    openGroupPicker(addPendingGroupToObject);
  });

  document.getElementById('openAddMemberModal')?.addEventListener('click', () => {
    document.getElementById('memberLookupInput').value = '';
    setLookupMessage(document.getElementById('memberLookupResults'), 'Wpisz co najmniej 2 znaki.');
    addMemberModal.show();
  });

  document.getElementById('openReferenceModal')?.addEventListener('click', () => {
    state.currentUserDn = document.getElementById('openReferenceModal').dataset.userdn;
    openUserPicker({
      title: 'Kopiuj grupy z innego użytkownika',
      subtitle: 'Wybierz użytkownika, którego grupy chcesz skopiować'
    }, showCopyGroupsFromUser);
  });

  document.querySelectorAll('.remove-group-btn').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const groupDn = btn.dataset.groupdn;
      state.pendingChanges.removeGroups.add(groupDn);
      state.pendingChanges.addGroups.delete(groupDn);
      btn.closest('.member-of-line')?.classList.add('pending-removal');
    });
  });

  document.querySelectorAll('.remove-member-btn').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const memberDn = btn.dataset.memberdn;
      state.pendingChanges.removeMembers.add(memberDn);
      state.pendingChanges.addMembers.delete(memberDn);
      btn.closest('.member-of-line')?.classList.add('pending-removal');
    });
  });

  document.getElementById('newOuDn')?.addEventListener('change', (event) => {
    state.pendingChanges.moveTargetDn = event.target.value || null;
  });

  document.querySelectorAll('input[name="accountExpiresMode"]').forEach((radio) => {
    if (radio.dataset.bound) return;
    radio.dataset.bound = '1';
    radio.addEventListener('change', (event) => {
      const form = event.target.closest('form');
      const dateInput = form?.querySelector('input[name="accountExpiresDate"]');
      if (!dateInput) return;
      dateInput.disabled = event.target.value !== 'date';
    });
  });

  document.getElementById('userSettingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const formData = new FormData(event.target);
      const payload = {
        objectDn: state.currentObjectDn,
        mail: formData.get('mail') || '',
        mustChangePasswordAtNextLogon: parseTruthy(formData.get('mustChangePasswordAtNextLogon')),
        userCannotChangePassword: parseTruthy(formData.get('userCannotChangePassword')),
        passwordNeverExpires: parseTruthy(formData.get('passwordNeverExpires')),
        accountDisabled: parseTruthy(formData.get('accountDisabled')),
        smartcardRequired: parseTruthy(formData.get('smartcardRequired')),
        accountExpiresMode: formData.get('accountExpiresMode') || 'never',
        accountExpiresDate: formData.get('accountExpiresDate') || '',
        profilePath: formData.get('profilePath') || '',
        scriptPath: formData.get('scriptPath') || '',
        homeDirectory: formData.get('homeDirectory') || '',
        homeDrive: formData.get('homeDrive') || ''
      };
      await api('/api/user/settings', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Ustawienia użytkownika zapisane');
      await openObject(state.currentObjectDn, 'user');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  bindOuPickers();
}

function bindOuPickers() {
  document.querySelectorAll('.pick-ou-btn').forEach((btn) => {
    btn.onclick = () => openOuPicker(btn.dataset.targetInput);
  });
}

const ouTreeEl = document.getElementById('ouTree');
const ouSearchInput = document.getElementById('ouSearchInput');
const ouSearchResults = document.getElementById('ouSearchResults');
const ouSelectedPath = document.getElementById('ouSelectedPath');
const confirmOuBtn = document.getElementById('confirmOuBtn');

async function fetchOuChildren(parentDn = '') {
  const cacheKey = parentDn || 'root';
  if (state.ouTreeCache.has(cacheKey)) return state.ouTreeCache.get(cacheKey);
  const params = new URLSearchParams({ ouOnly: '1' });
  if (parentDn) params.set('parentDn', parentDn);
  const data = await api(`/api/ou-children?${params.toString()}`);
  data.sort((x, y) => getDisplayName(x).localeCompare(getDisplayName(y), 'pl', { sensitivity: 'base' }));
  state.ouTreeCache.set(cacheKey, data);
  return data;
}

function selectOu(dn) {
  state.selectedOuDn = dn || null;
  document.querySelectorAll('#ouPickerModal .ou-row.selected').forEach((x) => x.classList.remove('selected'));
  if (dn) {
    document.querySelectorAll('#ouPickerModal .ou-row').forEach((row) => {
      if (row.dataset.dn && row.dataset.dn.toLowerCase() === dn.toLowerCase()) row.classList.add('selected');
    });
  }
  confirmOuBtn.disabled = !dn;
  ouSelectedPath.innerHTML = dn
    ? `<span class="text-muted me-1">Wybrano:</span><span class="path-inline" title="${escapeHtml(dn)}">${dnToPathHtml(dn)}</span>`
    : '<span class="text-muted">Nie wybrano OU</span>';
}

function confirmOuSelection() {
  if (!state.selectedOuDn || !state.selectedOuInputId) return;
  setOuFieldValue(state.selectedOuInputId, state.selectedOuDn);
  ouPickerModal.hide();
}

function createOuTreeNode(item, depth) {
  const dn = item.dn || item.distinguishedName;
  const li = document.createElement('li');
  li.setAttribute('role', 'treeitem');

  const row = document.createElement('div');
  row.className = 'ou-row';
  row.dataset.dn = dn;
  row.style.setProperty('--depth', depth);
  row.innerHTML = `
    <button type="button" class="ou-toggle" aria-label="Rozwiń">${icon('chevron-right')}</button>
    <span class="ou-row-icon">${icon('folder')}</span>
    <span class="ou-row-name">${escapeHtml(getDisplayName(item))}</span>
  `;
  li.appendChild(row);

  const children = document.createElement('ul');
  children.className = 'ou-children d-none';
  children.setAttribute('role', 'group');
  li.appendChild(children);

  const toggle = row.querySelector('.ou-toggle');
  const expand = async (forceOpen = false) => {
    const isOpen = !children.classList.contains('d-none');
    if (isOpen && !forceOpen) {
      children.classList.add('d-none');
      row.classList.remove('expanded');
      return;
    }
    if (!children.dataset.loaded) {
      row.classList.add('loading');
      try {
        const items = await fetchOuChildren(dn);
        items.forEach((child) => children.appendChild(createOuTreeNode(child, depth + 1)));
        children.dataset.loaded = '1';
        if (!items.length) row.classList.add('leaf');
      } catch (error) {
        showToast(error.message, true);
      } finally {
        row.classList.remove('loading');
      }
    }
    children.classList.remove('d-none');
    row.classList.add('expanded');
    if (state.selectedOuDn) selectOu(state.selectedOuDn);
  };
  li._expand = expand;

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    expand();
  });
  row.addEventListener('click', () => selectOu(dn));
  row.addEventListener('dblclick', () => {
    selectOu(dn);
    confirmOuSelection();
  });
  return li;
}

// Expands the tree along the path to `dn` so the current value is visible.
async function revealOuInTree(dn) {
  const target = String(dn || '').toLowerCase();
  if (!target) return;
  const findLi = (parentEl) => Array.from(parentEl.querySelectorAll(':scope > li')).find((li) => {
    const liDn = li.querySelector(':scope > .ou-row')?.dataset.dn?.toLowerCase() || '';
    return target === liDn || target.endsWith(`,${liDn}`);
  });
  let list = ouTreeEl.querySelector('.ou-root-list');
  while (list) {
    const li = findLi(list);
    if (!li) return;
    const liDn = li.querySelector(':scope > .ou-row').dataset.dn.toLowerCase();
    if (liDn === target) {
      li.querySelector(':scope > .ou-row').scrollIntoView({ block: 'center' });
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await li._expand(true);
    list = li.querySelector(':scope > .ou-children');
  }
}

async function renderOuTree() {
  ouTreeEl.innerHTML = '<div class="lookup-empty"><span class="spinner-border spinner-border-sm text-primary"></span> Ładowanie struktury katalogu…</div>';
  try {
    const rootItems = await fetchOuChildren('');
    ouTreeEl.innerHTML = `
      <div class="ou-domain-row">${icon('domain')}<span>${escapeHtml(AD_DOMAIN || 'Domena')}</span></div>
      <ul class="ou-root-list" role="group"></ul>
    `;
    const list = ouTreeEl.querySelector('.ou-root-list');
    rootItems.forEach((item) => list.appendChild(createOuTreeNode(item, 0)));
    if (!rootItems.length) ouTreeEl.insertAdjacentHTML('beforeend', '<div class="lookup-empty">Brak jednostek organizacyjnych.</div>');
  } catch (error) {
    ouTreeEl.innerHTML = `<div class="lookup-empty text-danger">${escapeHtml(error.message)}</div>`;
  }
}

function renderOuSearchResults(rows) {
  if (!rows.length) {
    ouSearchResults.innerHTML = '<div class="lookup-empty">Brak pasujących OU.</div>';
    return;
  }
  ouSearchResults.innerHTML = '';
  rows.forEach((item) => {
    const dn = item.dn || item.distinguishedName;
    const row = document.createElement('div');
    row.className = 'ou-row ou-row-flat';
    row.dataset.dn = dn;
    row.innerHTML = `
      <span class="ou-row-icon">${icon('folder')}</span>
      <span class="ou-row-text">
        <span class="ou-row-name">${escapeHtml(getDisplayName(item))}</span>
        <span class="ou-row-path">${dnToPathHtml(parentDn(dn))}</span>
      </span>
    `;
    row.addEventListener('click', () => selectOu(dn));
    row.addEventListener('dblclick', () => {
      selectOu(dn);
      confirmOuSelection();
    });
    ouSearchResults.appendChild(row);
  });
  if (state.selectedOuDn) selectOu(state.selectedOuDn);
}

let ouSearchSeq = 0;
const runOuSearch = debounce(async () => {
  const q = ouSearchInput.value.trim();
  const mySeq = ++ouSearchSeq;
  const searching = q.length >= 2;
  ouTreeEl.classList.toggle('d-none', searching);
  ouSearchResults.classList.toggle('d-none', !searching);
  if (!searching) return;
  ouSearchResults.innerHTML = '<div class="lookup-empty"><span class="spinner-border spinner-border-sm text-primary"></span> Wyszukiwanie…</div>';
  try {
    const rows = await api(`/api/ou-search?q=${encodeURIComponent(q)}`);
    if (mySeq !== ouSearchSeq) return;
    rows.sort((x, y) => getDisplayName(x).localeCompare(getDisplayName(y), 'pl', { sensitivity: 'base' }));
    renderOuSearchResults(rows);
  } catch (error) {
    if (mySeq === ouSearchSeq) ouSearchResults.innerHTML = `<div class="lookup-empty text-danger">${escapeHtml(error.message)}</div>`;
  }
}, 250);

ouSearchInput.addEventListener('input', runOuSearch);

async function openOuPicker(targetInputId) {
  state.selectedOuInputId = targetInputId;
  const current = document.getElementById(targetInputId)?.value || '';
  ouSearchInput.value = '';
  ouTreeEl.classList.remove('d-none');
  ouSearchResults.classList.add('d-none');
  selectOu(current || null);
  ouPickerModal.show();
  await renderOuTree();
  if (current) {
    await revealOuInTree(current);
    selectOu(current);
  }
}

document.getElementById('ouPickerModal').addEventListener('shown.bs.modal', () => ouSearchInput.focus());
confirmOuBtn.addEventListener('click', confirmOuSelection);

document.getElementById('confirmSoftDeleteBtn')?.addEventListener('click', async () => {
  if (!state.softDeleteTargetDn) return;
  try {
    const result = await api('/api/object/soft-delete', {
      method: 'POST',
      body: JSON.stringify({ objectDn: state.softDeleteTargetDn })
    });
    const removed = result.removedGroups || [];
    const failed = result.failedGroups || [];
    document.getElementById('softDeleteSuccessBody').innerHTML = `
      <p class="mb-2">Konto zostało wyłączone i przeniesione do OU <code>zablokowane_konta</code>.</p>
      <p class="mb-0">Usunięto z <strong>${removed.length}</strong> z ${(result.groupsBefore || []).length} grup. Lista grup sprzed usunięcia jest zapisana w logach obiektu.</p>
      ${failed.length ? `<div class="alert alert-danger small mt-3 mb-0"><strong>Nie udało się usunąć z ${failed.length} grup(y):</strong>${formatDnList(failed.map((f) => f.groupDn))}</div>` : ''}
    `;
    softDeleteConfirmModal.hide();
    softDeleteSuccessModal.show();
    showToast(failed.length ? `Konto zablokowane, ale ${failed.length} grup(y) nie usunięto` : 'Konto zablokowane i usunięte ze wszystkich grup', failed.length > 0);
    if (state.hasSearched) await runSearch();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById('confirmUnlockBtn')?.addEventListener('click', async () => {
  if (!state.unlockTargetDn) return;
  const targetOuDn = document.getElementById('unlockTargetOuDn')?.value || '';
  if (!targetOuDn) {
    showToast('Najpierw wybierz docelowe OU', true);
    return;
  }
  try {
    await api('/api/object/unlock', {
      method: 'POST',
      body: JSON.stringify({ objectDn: state.unlockTargetDn, targetOuDn })
    });
    unlockAccountModal.hide();
    showToast('Konto odblokowane i przeniesione');
    if (state.hasSearched) await runSearch();
  } catch (error) {
    showToast(error.message, true);
  }
});

function openGroupPicker(handler) {
  state.groupPickHandler = handler;
  document.getElementById('groupLookupInput').value = '';
  setLookupMessage(document.getElementById('groupLookupResults'), 'Wpisz co najmniej 2 znaki.');
  groupSearchModal.show();
}

function openUserPicker({ title, subtitle }, handler) {
  state.userPickHandler = handler;
  document.getElementById('referenceUserModalTitle').textContent = title || 'Wybierz użytkownika';
  document.getElementById('referenceUserModalSub').textContent = subtitle || 'Wyszukiwane są wyłącznie konta użytkowników';
  document.getElementById('referenceLookupInput').value = '';
  setLookupMessage(document.getElementById('referenceLookupResults'), 'Wpisz co najmniej 2 znaki.');
  referenceUserModal.show();
}

document.getElementById('groupSearchModal').addEventListener('shown.bs.modal', () => document.getElementById('groupLookupInput').focus());
document.getElementById('referenceUserModal').addEventListener('shown.bs.modal', () => document.getElementById('referenceLookupInput').focus());
document.getElementById('addMemberModal').addEventListener('shown.bs.modal', () => document.getElementById('memberLookupInput').focus());

function addPendingGroupToObject(item) {
  const pickedDn = item.dn || item.distinguishedName;
  state.pendingChanges.addGroups.add(pickedDn);
  state.pendingChanges.removeGroups.delete(pickedDn);
  const list = document.getElementById('memberOfList');
  if (list && !list.querySelector(`[data-groupdn="${cssEscapeValue(pickedDn)}"]`)) {
    list.querySelector(':scope > .text-muted')?.remove();
    list.insertAdjacentHTML('beforeend', renderPendingMemberLine(pickedDn, true));
    bindModalActions();
  }
  showToast('Dodano do zmian oczekujących');
}

async function showCopyGroupsFromUser(item) {
  state.referenceUserDn = item.dn || item.distinguishedName;
  const data = await api(`/api/object?dn=${encodeURIComponent(state.referenceUserDn)}`);
  state.copyGroups = toArray(data.memberOf);
  document.getElementById('copyGroupsList').innerHTML = state.copyGroups.length
    ? state.copyGroups.map((groupDn, idx) => `<label class="check-row" for="copy-group-${idx}"><input class="form-check-input copy-group-check" id="copy-group-${idx}" type="checkbox" checked value="${escapeHtml(groupDn)}"><span title="${escapeHtml(groupDn)}">${dnChipContent(groupDn)}</span></label>`).join('')
    : '<div class="lookup-empty">Wybrany użytkownik nie należy do żadnej grupy.</div>';
  copyGroupsModal.show();
}

bindLookup(
  document.getElementById('groupLookupInput'),
  document.getElementById('groupLookupResults'),
  (q) => api(`/api/search?q=${encodeURIComponent(q)}&type=group`),
  async (item) => {
    groupSearchModal.hide();
    try {
      await state.groupPickHandler?.(item);
    } catch (error) {
      showToast(error.message, true);
    }
  }
);

const runMemberLookup = bindLookup(
  document.getElementById('memberLookupInput'),
  document.getElementById('memberLookupResults'),
  (q) => api(`/api/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(document.getElementById('memberLookupType')?.value || 'all')}`),
  (item) => {
    const pickedDn = item.dn || item.distinguishedName;
    if (pickedDn === state.currentObjectDn) {
      showToast('Nie można dodać grupy jako własnego członka', true);
      return;
    }
    state.pendingChanges.addMembers.add(pickedDn);
    state.pendingChanges.removeMembers.delete(pickedDn);
    const list = document.getElementById('membersList');
    if (list && !list.querySelector(`[data-memberdn="${cssEscapeValue(pickedDn)}"]`)) {
      list.querySelector(':scope > .text-muted')?.remove();
      list.insertAdjacentHTML('beforeend', renderPendingMemberEntry(pickedDn, true));
      bindModalActions();
    }
    addMemberModal.hide();
    showToast('Dodano do zmian oczekujących');
  }
);
document.getElementById('memberLookupType')?.addEventListener('change', runMemberLookup);

// Users only: the search endpoint is called with type=user and computer
// accounts (which also carry objectClass=user) are filtered out.
bindLookup(
  document.getElementById('referenceLookupInput'),
  document.getElementById('referenceLookupResults'),
  async (q) => {
    const rows = await api(`/api/search?q=${encodeURIComponent(q)}&type=user`);
    return rows.filter((row) => detectType(row) === 'user');
  },
  async (item) => {
    referenceUserModal.hide();
    try {
      await state.userPickHandler?.(item);
    } catch (error) {
      showToast(error.message, true);
    }
  }
);

document.getElementById('selectAllCopyGroups').addEventListener('click', () => {
  document.querySelectorAll('.copy-group-check').forEach((x) => { x.checked = true; });
});

document.getElementById('clearAllCopyGroups').addEventListener('click', () => {
  document.querySelectorAll('.copy-group-check').forEach((x) => { x.checked = false; });
});

document.getElementById('applyCopyGroupsBtn').addEventListener('click', async () => {
  const selectedGroups = Array.from(document.querySelectorAll('.copy-group-check:checked')).map((x) => x.value);
  selectedGroups.forEach((groupDn) => {
    state.pendingChanges.addGroups.add(groupDn);
    state.pendingChanges.removeGroups.delete(groupDn);
  });
  const list = document.getElementById('memberOfList');
  if (list) {
    list.querySelector(':scope > .text-muted')?.remove();
    selectedGroups.forEach((groupDn) => {
      if (!list.querySelector(`[data-groupdn="${cssEscapeValue(groupDn)}"]`)) {
        list.insertAdjacentHTML('beforeend', renderPendingMemberLine(groupDn, true));
      }
    });
    bindModalActions();
  }
  copyGroupsModal.hide();
  showToast('Grupy dodane do zmian oczekujących');
});

document.querySelectorAll('input[name="typeFilter"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (state.hasSearched) runSearch();
    searchInput.focus();
  });
});

document.getElementById('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});

['searchField', 'searchSubtree', 'searchStatus', 'searchLogon', 'searchDays', 'searchLimit'].forEach((id) => {
  document.getElementById(id).addEventListener('change', updateActiveFiltersBadge);
});
searchOuDn.addEventListener('change', updateActiveFiltersBadge);

document.getElementById('clearSearchOuBtn').addEventListener('click', () => setOuFieldValue('searchOuDn', ''));

document.getElementById('resetFiltersBtn').addEventListener('click', () => {
  document.getElementById('searchField').value = 'any';
  document.getElementById('searchSubtree').checked = true;
  document.getElementById('searchStatus').value = '';
  document.getElementById('searchLogon').value = '';
  document.getElementById('searchDays').value = '90';
  document.getElementById('searchLimit').value = '50';
  setOuFieldValue('searchOuDn', '');
});

document.querySelectorAll('#resultsTable th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    const current = state.searchSort;
    // name/path/status start ascending; last logon starts with most recent.
    const firstDir = key === 'logon' ? -1 : 1;
    state.searchSort = current.key === key ? { key, dir: -current.dir } : { key, dir: firstDir };
    if (state.searchResults.length) renderSearchResults();
  });
});

// Page header follows the active sidebar tab.
document.querySelectorAll('.app-nav-link[data-bs-toggle="tab"]').forEach((tab) => {
  tab.addEventListener('shown.bs.tab', () => {
    document.getElementById('pageTitle').textContent = tab.dataset.pageTitle || '';
    document.getElementById('pageSub').textContent = tab.dataset.pageSub || '';
    if (tab.id === 'search-tab') searchInput.focus();
  });
});

document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = document.getElementById(btn.dataset.gotoTab);
    if (tab) bootstrap.Tab.getOrCreateInstance(tab).show();
  });
});


reportsList?.addEventListener('click', (event) => {
  const button = event.target.closest('.report-link');
  if (!button) return;
  switchReportPage(button.dataset.report);
  if (button.dataset.report === 'portal-activity') {
    loadPortalActivityReport(1);
  }
  if (button.dataset.report === 'login-history') {
    loadGlobalAuditWidgets();
  }
});

portalActivityFilterForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await loadPortalActivityReport(1);
});

portalActivityPrev?.addEventListener('click', () => {
  if (state.portalActivityPage <= 1) return;
  loadPortalActivityReport(state.portalActivityPage - 1);
});

portalActivityNext?.addEventListener('click', () => {
  loadPortalActivityReport(state.portalActivityPage + 1);
});

loadReportBtn.addEventListener('click', async () => {
  try {
    const years = Number(document.getElementById('reportYears').value || 2);
    reportResult.innerHTML = '<div class="lookup-empty"><span class="spinner-border spinner-border-sm text-primary"></span> Generowanie raportu…</div>';
    const data = await api(`/api/reports/stale-logons?years=${years}`);
    const rows = data.map((u) => `
      <tr class="${isAccountDisabled(u) ? 'row-disabled' : ''}">
        <td><span class="fw-semibold">${escapeHtml(getDisplayName(u))}</span><div class="small text-muted font-monospace">${escapeHtml(u.sAMAccountName || '')}</div></td>
        <td class="text-nowrap">${u.lastLogonDate ? escapeHtml(new Date(u.lastLogonDate).toLocaleDateString('pl-PL')) : '<span class="text-muted">nigdy</span>'}</td>
        <td><span class="path-inline" title="${escapeHtml(u.dn || '')}">${dnToPathHtml(parentDn(u.dn), { skipDomain: true })}</span></td>
      </tr>`).join('');
    reportResult.innerHTML = `
      <div class="mb-2">Znaleziono <strong>${data.length}</strong> kont bez logowania od ${years} lat.</div>
      ${data.length ? `<div class="table-responsive report-table-wrap"><table class="table table-sm table-hover align-middle mb-0"><thead><tr><th>Użytkownik</th><th>Ostatnie logowanie</th><th>Lokalizacja</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
    showToast('Raport wygenerowany');
  } catch (error) {
    showToast(error.message, true);
  }
});

async function loadDashboardStats() {
  try {
    const data = await api('/api/dashboard/stats');
    if (statUsers) statUsers.textContent = data.users;
    if (statActiveUsers) statActiveUsers.textContent = data.activeUsers;
    if (statActiveUsersWithoutBlockedOu) statActiveUsersWithoutBlockedOu.textContent = data.activeUsersWithoutBlockedOu;
    if (statGroups) statGroups.textContent = data.groups;
    if (statComputers) statComputers.textContent = data.computers;
    if (statOus) statOus.textContent = data.ous;
    if (statTotal) statTotal.textContent = data.total;
  } catch (error) {
    showToast(`Dashboard: ${error.message}`, true);
  }
}

applyObjectChangesBtn.addEventListener('click', async () => {
  try {
    const operations = [];
    const addDns = Array.from(state.pendingChanges?.addGroups || []);
    const removeDns = Array.from(state.pendingChanges?.removeGroups || []);
    const addMemberDns = Array.from(state.pendingChanges?.addMembers || []);
    const removeMemberDns = Array.from(state.pendingChanges?.removeMembers || []);
    const moveTargetDn = state.pendingChanges?.moveTargetDn;

    if (addDns.length || removeDns.length) {
      operations.push(api('/api/user/groups', {
        method: 'POST',
        body: JSON.stringify({ userDn: state.currentObjectDn, addDns, removeDns })
      }));
    }

    if (addMemberDns.length || removeMemberDns.length) {
      operations.push(api('/api/group/members', {
        method: 'POST',
        body: JSON.stringify({ groupDn: state.currentObjectDn, addMemberDns, removeMemberDns })
      }));
    }

    if (moveTargetDn) {
      operations.push(api('/api/object/move', {
        method: 'POST',
        body: JSON.stringify({ objectDn: state.currentObjectDn, newParentOuDn: moveTargetDn })
      }));
    }

    if (!operations.length) {
      showToast('Brak zmian do zastosowania');
      return;
    }

    await Promise.all(operations);
    objectModal.hide();
    showToast('Zmiany zostały zastosowane');
    if (state.hasSearched) await runSearch();
  } catch (error) {
    showToast(error.message, true);
  }
});

// ===== Kreator nowego użytkownika =====
const newUserModalEl = document.getElementById('newUserModal');
const newUserForm = document.getElementById('newUserForm');
const newUserFirstName = document.getElementById('newUserFirstName');
const newUserLastName = document.getElementById('newUserLastName');
const newUserLogin = document.getElementById('newUserLogin');
const newUserLoginStatus = document.getElementById('newUserLoginStatus');
const newUserUpnPreview = document.getElementById('newUserUpnPreview');
const newUserPassword = document.getElementById('newUserPassword');
const newUserOuDn = document.getElementById('newUserOuDn');
const newUserSubmitBtn = document.getElementById('newUserSubmitBtn');
const newUserGroupsList = document.getElementById('newUserGroupsList');
const LOGIN_HINT = 'Generowany automatycznie po wpisaniu imienia i nazwiska. Można go zmienić.';
let newUserLoginAvailable = false;
let newUserLoginSeq = 0;

function updateNewUserSubmitState() {
  const ready = newUserLoginAvailable
    && newUserFirstName.value.trim()
    && newUserLastName.value.trim()
    && newUserPassword.value
    && newUserOuDn.value;
  newUserSubmitBtn.disabled = !ready;
}

function setNewUserLoginState(kind, message) {
  newUserLoginAvailable = kind === 'ok';
  newUserLoginStatus.textContent = message || LOGIN_HINT;
  newUserLoginStatus.classList.toggle('text-success', kind === 'ok');
  newUserLoginStatus.classList.toggle('text-danger', kind === 'error');
  newUserLogin.classList.toggle('is-valid', kind === 'ok');
  newUserLogin.classList.toggle('is-invalid', kind === 'error');
  const login = newUserLogin.value.trim();
  newUserUpnPreview.innerHTML = login && AD_DOMAIN
    ? `Nazwa logowania: <span class="font-monospace">${escapeHtml(login)}@${escapeHtml(AD_DOMAIN)}</span>, nazwa obiektu w AD: <span class="font-monospace">${escapeHtml(login)}</span>`
    : '';
  updateNewUserSubmitState();
}

async function checkNewUserLoginAvailability() {
  const login = newUserLogin.value.trim();
  const mySeq = ++newUserLoginSeq;
  if (!login) {
    setNewUserLoginState('idle', '');
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(login)) {
    setNewUserLoginState('error', 'Dozwolone znaki: litery bez polskich znaków, cyfry, kropka, myślnik, podkreślnik.');
    return;
  }
  if (login.length > 20) {
    setNewUserLoginState('error', 'Login może mieć maksymalnie 20 znaków (limit sAMAccountName).');
    return;
  }
  try {
    setNewUserLoginState('checking', 'Sprawdzanie dostępności…');
    const result = await api(`/api/user/login-availability?login=${encodeURIComponent(login)}`);
    if (mySeq !== newUserLoginSeq) return;
    setNewUserLoginState(result.available ? 'ok' : 'error', result.available ? 'Login dostępny.' : 'Login zajęty, wybierz inny.');
  } catch (error) {
    if (mySeq === newUserLoginSeq) setNewUserLoginState('error', error.message);
  }
}

async function autoFillNewUserLogin({ force = false } = {}) {
  if (state.newUser.loginTouched && !force) return;
  const firstName = newUserFirstName.value.trim();
  const lastName = newUserLastName.value.trim();
  const mySeq = ++newUserLoginSeq;
  if (!firstName || !lastName) {
    newUserLogin.value = '';
    setNewUserLoginState('idle', '');
    return;
  }
  try {
    setNewUserLoginState('checking', 'Generowanie loginu…');
    const result = await api(`/api/user/suggest-login?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}`);
    if (mySeq !== newUserLoginSeq) return;
    newUserLogin.value = result.login || '';
    setNewUserLoginState(
      result.available ? 'ok' : 'error',
      result.available ? 'Login wygenerowany i dostępny. Możesz go zmienić.' : 'Nie znaleziono wolnego loginu, wpisz go ręcznie.'
    );
  } catch (error) {
    if (mySeq === newUserLoginSeq) setNewUserLoginState('error', error.message);
  }
}

const debouncedAutoFillNewUserLogin = debounce(() => autoFillNewUserLogin(), 400);
const debouncedCheckNewUserLoginAvailability = debounce(checkNewUserLoginAvailability, 350);

newUserFirstName.addEventListener('input', () => {
  debouncedAutoFillNewUserLogin();
  updateNewUserSubmitState();
});
newUserLastName.addEventListener('input', () => {
  debouncedAutoFillNewUserLogin();
  updateNewUserSubmitState();
});
newUserLogin.addEventListener('input', () => {
  // Once the admin edits the login by hand, name changes stop overwriting it.
  state.newUser.loginTouched = newUserLogin.value.trim() !== '';
  newUserLoginAvailable = false;
  updateNewUserSubmitState();
  debouncedCheckNewUserLoginAvailability();
});
document.getElementById('regenerateLoginBtn').addEventListener('click', () => {
  state.newUser.loginTouched = false;
  autoFillNewUserLogin({ force: true });
});
newUserPassword.addEventListener('input', updateNewUserSubmitState);
newUserOuDn.addEventListener('change', () => {
  document.getElementById('newUserOuFromReference').classList.add('d-none');
  updateNewUserSubmitState();
});

function generatePassword(length = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const random = (max) => {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] % max;
  };
  const chars = sets.map((set) => set[random(set.length)]);
  while (chars.length < length) chars.push(all[random(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

document.getElementById('toggleNewUserPasswordBtn').addEventListener('click', () => {
  newUserPassword.type = newUserPassword.type === 'password' ? 'text' : 'password';
});
document.getElementById('generateNewUserPasswordBtn').addEventListener('click', () => {
  newUserPassword.value = generatePassword();
  newUserPassword.type = 'text';
  updateNewUserSubmitState();
});

function renderNewUserGroups() {
  const groups = Array.from(state.newUser.groups);
  document.getElementById('newUserGroupsCount').textContent = String(groups.length);
  if (!groups.length) {
    newUserGroupsList.innerHTML = '<div class="chip-empty">Brak grup. Wybierz użytkownika wzorcowego lub dodaj grupy ręcznie.</div>';
    return;
  }
  newUserGroupsList.innerHTML = groups
    .sort((x, y) => dnLabel(x).localeCompare(dnLabel(y), 'pl', { sensitivity: 'base' }))
    .map((dn) => `<span class="chip" title="${escapeHtml(dn)}">${icon('group')}<span>${escapeHtml(dnLabel(dn))}</span><button type="button" class="chip-remove" data-dn="${escapeHtml(dn)}" aria-label="Usuń grupę" title="Usuń">${icon('x')}</button></span>`)
    .join('');
}

newUserGroupsList.addEventListener('click', (event) => {
  const btn = event.target.closest('.chip-remove');
  if (!btn) return;
  state.newUser.groups.delete(btn.dataset.dn);
  renderNewUserGroups();
});

document.getElementById('newUserAddGroupBtn').addEventListener('click', () => {
  openGroupPicker((item) => {
    state.newUser.groups.add(item.dn || item.distinguishedName);
    renderNewUserGroups();
  });
});

async function applyReferenceUser(item) {
  const dn = item.dn || item.distinguishedName;
  const data = await api(`/api/object?dn=${encodeURIComponent(dn)}`);
  const refDn = toArray(data.distinguishedName)[0] || dn;
  const name = getDisplayName({ ...item, ...data, objectClass: item.objectClass });
  const login = toArray(data.sAMAccountName)[0] || item.sAMAccountName || '';

  state.newUser.referenceDn = refDn;
  document.getElementById('newUserReferenceDn').value = refDn;
  document.getElementById('newUserReferenceEmpty').classList.add('d-none');
  document.getElementById('newUserReferenceSelected').classList.remove('d-none');
  document.getElementById('newUserReferenceAvatar').textContent = initials(name);
  document.getElementById('newUserReferenceName').textContent = login ? `${name} (${login})` : name;
  document.getElementById('newUserReferenceMeta').innerHTML = dnToPathHtml(parentDn(refDn));

  setOuFieldValue('newUserOuDn', parentDn(refDn));
  document.getElementById('newUserOuFromReference').classList.remove('d-none');

  state.newUser.groups = new Set(toArray(data.memberOf));
  renderNewUserGroups();
  updateNewUserSubmitState();
  showToast(`Skopiowano OU i ${state.newUser.groups.size} grup(y) od: ${name}`);
}

function clearReferenceUser() {
  state.newUser.referenceDn = null;
  document.getElementById('newUserReferenceDn').value = '';
  document.getElementById('newUserReferenceEmpty').classList.remove('d-none');
  document.getElementById('newUserReferenceSelected').classList.add('d-none');
  document.getElementById('newUserOuFromReference').classList.add('d-none');
}

const pickReferenceUser = () => openUserPicker({
  title: 'Wybierz użytkownika wzorcowego',
  subtitle: 'Nowe konto otrzyma to samo OU i te same grupy'
}, applyReferenceUser);

document.getElementById('pickReferenceUserBtn').addEventListener('click', pickReferenceUser);
document.getElementById('changeReferenceUserBtn').addEventListener('click', pickReferenceUser);
document.getElementById('clearReferenceUserBtn').addEventListener('click', () => {
  clearReferenceUser();
  state.newUser.groups.clear();
  renderNewUserGroups();
});

function resetNewUserForm() {
  newUserForm.reset();
  newUserForm.querySelector('input[name="accountExpiresDate"]').disabled = true;
  newUserPassword.type = 'password';
  state.newUser = { referenceDn: null, groups: new Set(), loginTouched: false };
  clearReferenceUser();
  setOuFieldValue('newUserOuDn', '', { silent: true });
  renderNewUserGroups();
  setNewUserLoginState('idle', '');
}

// The picker modals open on top of the wizard without hiding it, so this
// only fires when the wizard is opened fresh.
newUserModalEl.addEventListener('show.bs.modal', resetNewUserForm);
newUserModalEl.addEventListener('shown.bs.modal', () => newUserFirstName.focus());

newUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (newUserSubmitBtn.disabled) return;
  const spinner = document.getElementById('newUserSubmitSpinner');
  try {
    newUserSubmitBtn.disabled = true;
    spinner.classList.remove('d-none');
    const payload = Object.fromEntries(new FormData(event.target).entries());
    payload.login = String(payload.login || '').trim();
    payload.firstName = String(payload.firstName || '').trim();
    payload.lastName = String(payload.lastName || '').trim();
    payload.mustChangePasswordAtNextLogon = parseTruthy(payload.mustChangePasswordAtNextLogon);
    payload.userCannotChangePassword = parseTruthy(payload.userCannotChangePassword);
    payload.passwordNeverExpires = parseTruthy(payload.passwordNeverExpires);
    payload.accountDisabled = parseTruthy(payload.accountDisabled);
    payload.accountExpiresMode = payload.accountExpiresModeNewUser || 'never';
    payload.groups = Array.from(state.newUser.groups);
    delete payload.accountExpiresModeNewUser;
    const result = await api('/api/user/create', { method: 'POST', body: JSON.stringify(payload) });
    const failed = result.failedGroups || [];
    if (failed.length) {
      showToast(`Utworzono ${result.login}, ale nie dodano do ${failed.length} grup(y): ${failed.map((f) => dnLabel(f.groupDn)).join(', ')}`, true);
    } else {
      showToast(`Utworzono użytkownika ${result.login}${payload.groups.length ? ` i dodano do ${payload.groups.length} grup(y)` : ''}`);
    }
    bootstrap.Modal.getOrCreateInstance(newUserModalEl).hide();
    searchInput.value = result.login;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    spinner.classList.add('d-none');
    updateNewUserSubmitState();
  }
});

document.querySelectorAll('input[name="accountExpiresModeNewUser"]').forEach((radio) => {
  radio.addEventListener('change', (event) => {
    const form = event.target.closest('form');
    const dateInput = form?.querySelector('input[name="accountExpiresDate"]');
    if (!dateInput) return;
    dateInput.disabled = event.target.value !== 'date';
  });
});

// ===== Nowa grupa =====
const newGroupName = document.getElementById('newGroupName');
const newGroupSam = document.getElementById('newGroupSam');
newGroupName.addEventListener('input', () => {
  if (!newGroupSam.dataset.touched) newGroupSam.value = newGroupName.value.trim();
});
newGroupSam.addEventListener('input', () => {
  newGroupSam.dataset.touched = newGroupSam.value ? '1' : '';
});

document.getElementById('newGroupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!document.getElementById('newGroupOuDn').value) {
    showToast('Wybierz OU dla nowej grupy', true);
    return;
  }
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    await api('/api/group/create', { method: 'POST', body: JSON.stringify(payload) });
    showToast(`Utworzono grupę ${payload.name}`);
    event.target.reset();
    delete newGroupSam.dataset.touched;
    setOuFieldValue('newGroupOuDn', '', { silent: true });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('newGroupModal')).hide();
  } catch (error) {
    showToast(error.message, true);
  }
});

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cssEscapeValue(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replaceAll('"', '\\"');
}

// Stacked modals (e.g. OU picker over the user wizard): put each new modal and
// its backdrop above the previous one, and keep the body scroll-lock while
// any modal is still open.
document.addEventListener('show.bs.modal', (event) => {
  const openCount = document.querySelectorAll('.modal.show').length;
  if (!openCount) return;
  event.target.style.zIndex = String(1055 + openCount * 10);
  setTimeout(() => {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    const last = backdrops[backdrops.length - 1];
    if (last) last.style.zIndex = String(1054 + openCount * 10);
  });
});
document.addEventListener('hidden.bs.modal', (event) => {
  event.target.style.zIndex = '';
  const stillOpen = Array.from(document.querySelectorAll('.modal.show'));
  if (stillOpen.length) {
    document.body.classList.add('modal-open');
    // Return focus to the modal underneath so Escape / Tab keep working there.
    const top = stillOpen.sort((x, y) => Number(y.style.zIndex || 1055) - Number(x.style.zIndex || 1055))[0];
    if (!top.contains(document.activeElement)) top.focus();
  }
});

document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
  // eslint-disable-next-line no-new
  new bootstrap.Popover(el, { trigger: 'click', html: true });
});

bindOuPickers();
loadDashboardStats();
loadGlobalAuditWidgets();
initPortalActivityActions();
switchReportPage(state.activeReportPage);
