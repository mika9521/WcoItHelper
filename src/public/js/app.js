const searchBtn = document.getElementById('searchBtn');
const results = document.getElementById('results');
const typeFilter = document.getElementById('typeFilter');
const searchInput = document.getElementById('searchInput');
const searchTextWrap = document.getElementById('searchTextWrap');
const searchOuWrap = document.getElementById('searchOuWrap');
const searchOuDn = document.getElementById('searchOuDn');
const objectBody = document.getElementById('objectBody');
const objectTitle = document.getElementById('objectTitle');
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
const applyObjectChangesBtn = document.getElementById('applyObjectChangesBtn');

const state = {
  currentUserDn: null,
  referenceUserDn: null,
  copyGroups: [],
  selectedOuInputId: null,
  selectedOuOuOnly: true,
  selectedOuDn: null,
  softDeleteTargetDn: null,
  unlockTargetDn: null,
  bitlockerKeys: [],
  currentObjectDn: null,
  pendingChanges: null,
  ouTreeCache: new Map(),
  activeReportPage: 'stale-logons',
  portalActivityPage: 1
};

function showToast(message, isError = false) {
  const body = document.getElementById('toastBody');
  const toastEl = document.getElementById('appToast');
  toastEl.classList.toggle('text-bg-danger', isError);
  toastEl.classList.toggle('text-bg-primary', !isError);
  body.textContent = message;
  toast.show();
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

function getTypeBadgeHtml(type) {
  const abbr = { user: 'U', computer: 'K', group: 'G', ou: 'OU' }[type] || '?';
  return `<span class="type-badge type-badge-${escapeHtml(type)}">${escapeHtml(abbr)}</span>`;
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
  const disabled = isAccountDisabled(item);
  const inBlockedOu = isInBlockedOu(item);
  if (disabled && inBlockedOu) {
    tr.classList.add('table-danger');
  } else if (disabled) {
    tr.classList.add('table-warning');
  }

  const openDetails = () => {
    document.querySelectorAll('#results tr.result-active').forEach((row) => row.classList.remove('result-active'));
    tr.classList.add('result-active');
    openObject(dn, type);
  };

  const isLockable = type === 'user' || type === 'computer';
  const showUnlock = isLockable && disabled && inBlockedOu;
  const lockActionBtn = showUnlock
    ? '<button class="btn btn-sm btn-outline-success action-unlock">Odblokuj</button>'
    : (isLockable ? '<button class="btn btn-sm btn-outline-danger action-toggle">Zablokuj</button>' : '');

  tr.innerHTML = `
    <td><button type="button" class="btn btn-link p-0 type-open-btn" title="Szczegóły">${getTypeBadgeHtml(type)}</button></td>
    <td><button type="button" class="btn btn-link p-0 object-link">${name}</button><div class="small text-muted">${getTypeLabel(type)}</div></td>
    <td class="small">${dn || '-'}</td>
    <td>
      <div class="d-flex gap-1 justify-content-end flex-wrap">
        <button class="btn btn-sm btn-outline-primary action-open">Szczegóły</button>
        <button class="btn btn-sm btn-outline-warning action-move">Przenieś</button>
        ${lockActionBtn}
      </div>
    </td>
  `;

  tr.querySelector('.type-open-btn').addEventListener('click', openDetails);
  tr.querySelector('.object-link').addEventListener('click', openDetails);
  tr.querySelector('.action-open').addEventListener('click', openDetails);
  tr.querySelector('.action-move').addEventListener('click', () => openMoveOnly(dn, getDisplayName(item) || dn));
  tr.querySelector('.action-toggle')?.addEventListener('click', () => openSoftDeleteModal(item));
  tr.querySelector('.action-unlock')?.addEventListener('click', () => openUnlockModal(item));
  return tr;
}

async function runSearch() {
  try {
    const selectedType = typeFilter.value;
    const type = selectedType === 'ou-selection' ? 'all' : selectedType;
    const q = encodeURIComponent(searchInput?.value || '');
    let url = `/api/search?q=${q}&type=${encodeURIComponent(type)}`;
    if (selectedType === 'ou-selection') {
      if (!searchOuDn.value) {
        showToast('Najpierw wybierz OU do przeszukania', true);
        return;
      }
      url = `/api/search?ouDn=${encodeURIComponent(searchOuDn.value)}&type=${encodeURIComponent(type)}`;
    }
    const data = await api(url);
    results.innerHTML = '';
    data.forEach((row) => results.appendChild(renderResultItem(row)));
    if (!data.length) results.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3">Brak wyników</td></tr>';
  } catch (error) {
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
      ${groups.map((g) => `<div class="member-of-line" data-groupdn="${escapeHtml(g)}"><span class="badge text-bg-info group-badge">${escapeHtml(g)}</span><button type="button" class="btn-close remove-group-btn ms-2" aria-label="Usuń" data-groupdn="${escapeHtml(g)}"></button></div>`).join('') || '<span class="text-muted">Brak grup</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddGroupModal" data-userdn="${userDn}">Dodaj</button>
      <button class="btn btn-outline-secondary btn-sm" id="openReferenceModal" data-userdn="${userDn}">Inny użytkownik</button>
    </div>
  `;
}

function membersTemplate(data) {
  const members = Array.isArray(data.member) ? data.member : (data.member ? [data.member] : []);
  const groupDn = data.distinguishedName || data.dn;
  return `
    <div class="mb-2 group-member-list" id="membersList" data-groupdn="${escapeHtml(groupDn)}">
      ${members.map((m) => `<div class="member-of-line" data-memberdn="${escapeHtml(m)}"><span class="badge text-bg-secondary group-badge">${escapeHtml(m)}</span><button type="button" class="btn-close remove-member-btn ms-2" aria-label="Usuń" data-memberdn="${escapeHtml(m)}"></button></div>`).join('') || '<span class="text-muted">Brak członków</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddMemberModal" data-groupdn="${escapeHtml(groupDn)}">Dodaj członka</button>
    </div>
  `;
}

function renderPendingMemberEntry(memberDn, pendingAdd = false) {
  const badgeClass = pendingAdd ? 'text-bg-warning text-dark' : 'text-bg-secondary';
  return `<div class="member-of-line ${pendingAdd ? 'pending-added' : ''}" data-memberdn="${escapeHtml(memberDn)}"><span class="badge ${badgeClass} group-badge">${escapeHtml(memberDn)}</span><button type="button" class="btn-close remove-member-btn ms-2" aria-label="Usuń" data-memberdn="${escapeHtml(memberDn)}"></button></div>`;
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
    <div class="small text-muted mb-2">Certyfikaty kart inteligentnych (smart card) przypisane do konta w AD.</div>
    <div class="user-certificates-list" data-dn="${escapeHtml(dn || '')}">Ładowanie certyfikatów…</div>
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

async function loadUserCertificates(dn) {
  const holder = document.querySelector('.user-certificates-list');
  if (!holder || !dn) return;
  try {
    const rows = await api(`/api/user/certificates?dn=${encodeURIComponent(dn)}`);
    holder.innerHTML = rows.length
      ? `
        <div class="table-responsive">
          <table class="table table-sm table-striped align-middle mb-0">
            <thead>
              <tr><th>Podmiot</th><th>Wydawca</th><th>Ważny od</th><th>Ważny do</th><th>Numer seryjny</th><th></th></tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td class="small text-break">${escapeHtml(row.subjectCn || row.subject || '-')}</td>
                  <td class="small text-break">${escapeHtml(row.issuerCn || row.issuer || '-')}</td>
                  <td class="small">${escapeHtml(formatAdDate(row.validFrom))}</td>
                  <td class="small">${escapeHtml(formatAdDate(row.validTo))}</td>
                  <td class="font-monospace small text-break">${escapeHtml(row.serialNumber || '-')}</td>
                  <td><button type="button" class="btn btn-sm btn-outline-danger revoke-certificate-btn" data-raw="${escapeHtml(row.raw)}" data-subject="${escapeHtml(row.subjectCn || row.subject || '')}">Odwołaj certyfikat</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
      : '<div class="text-muted small">Brak certyfikatów przypisanych do tego konta.</div>';

    holder.querySelectorAll('.revoke-certificate-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const subject = btn.dataset.subject || 'ten certyfikat';
        if (!window.confirm(`Odwołać certyfikat "${subject}"? Użytkownik nie będzie mógł się nim zalogować kartą inteligentną.`)) return;
        try {
          await api('/api/user/certificates/revoke', {
            method: 'POST',
            body: JSON.stringify({ userDn: dn, certificateBase64: btn.dataset.raw, subjectCn: subject })
          });
          showToast('Certyfikat odwołany');
          await loadUserCertificates(dn);
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  } catch (error) {
    holder.innerHTML = `<div class="text-danger small">${escapeHtml(error.message)}</div>`;
  }
}

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
  const badgeClass = pendingAdd ? 'text-bg-warning text-dark' : 'text-bg-info';
  return `<div class="member-of-line ${pendingAdd ? 'pending-added' : ''}" data-groupdn="${escapeHtml(groupDn)}"><span class="badge ${badgeClass} group-badge">${escapeHtml(groupDn)}</span><button type="button" class="btn-close remove-group-btn ms-2" aria-label="Usuń" data-groupdn="${escapeHtml(groupDn)}"></button></div>`;
}

function moveTemplate(objectDn) {
  return `
    <label class="form-label">Nowe OU DN</label>
    <div class="input-group">
      <input id="newOuDn" class="form-control" placeholder="Wybierz OU..." readonly />
      <button class="btn btn-outline-secondary pick-ou-btn" data-target-input="newOuDn" data-ou-only="1">Wybierz OU</button>
    </div>
    <div class="form-text mt-2">Zmiana zostanie wykonana po kliknięciu „Zastosuj”.</div>
    <input type="hidden" id="moveObjectDn" value="${escapeHtml(objectDn)}" />
  `;
}

async function openObject(dn, typeHint) {
  try {
    const data = await api(`/api/object?dn=${encodeURIComponent(dn)}`);
    const type = typeHint || detectType(data);
    objectTitle.textContent = `${getDisplayName(data)} (${getTypeLabel(type)})`;
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
  objectTitle.textContent = `Przeniesienie: ${label}`;
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
  softDeleteConfirmModal.show();
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
  const ouInput = document.getElementById('unlockTargetOuDn');
  if (ouInput) ouInput.value = '';
  unlockAccountModal.show();
}

function renderLookupItem(container, item, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const type = detectType(item);
  btn.className = 'list-group-item list-group-item-action';
  btn.innerHTML = `${getTypeBadgeHtml(type)} ${escapeHtml(getDisplayName(item))}<div class="small text-muted">${escapeHtml(item.dn || item.distinguishedName || '')}</div>`;
  btn.addEventListener('click', () => onPick(item));
  container.appendChild(btn);
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
    document.getElementById('groupLookupInput').value = '';
    document.getElementById('groupLookupResults').innerHTML = '';
    groupSearchModal.show();
  });

  document.getElementById('openAddMemberModal')?.addEventListener('click', () => {
    document.getElementById('memberLookupInput').value = '';
    document.getElementById('memberLookupResults').innerHTML = '';
    addMemberModal.show();
  });

  document.getElementById('openReferenceModal')?.addEventListener('click', () => {
    state.currentUserDn = document.getElementById('openReferenceModal').dataset.userdn;
    document.getElementById('referenceLookupInput').value = '';
    document.getElementById('referenceLookupResults').innerHTML = '';
    referenceUserModal.show();
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
    btn.onclick = async () => {
      state.selectedOuInputId = btn.dataset.targetInput;
      state.selectedOuOuOnly = btn.dataset.ouOnly !== '0';
      state.selectedOuDn = null;
      await renderOuTree();
      ouPickerModal.show();
    };
  });
}

async function fetchOuChildren(parentDn = '', onlyOu = true) {
  const cacheKey = `${parentDn || 'root'}::${onlyOu ? 'ou' : 'all'}`;
  if (state.ouTreeCache.has(cacheKey)) return state.ouTreeCache.get(cacheKey);
  const params = new URLSearchParams();
  if (parentDn) params.set('parentDn', parentDn);
  if (onlyOu) params.set('ouOnly', '1');
  const data = await api(`/api/ou-children${params.toString() ? `?${params.toString()}` : ''}`);
  state.ouTreeCache.set(cacheKey, data);
  return data;
}

async function renderOuTree() {
  const tree = document.getElementById('ouTree');
  const rootItems = await fetchOuChildren('', state.selectedOuOuOnly);
  tree.innerHTML = '<div class="small text-muted mb-2">Kliknij ▶ aby rozwinąć OU. Kliknij nazwę, aby wybrać.</div>';

  const rootList = document.createElement('ul');
  rootList.className = 'ou-tree-list';
  tree.appendChild(rootList);

  rootItems.forEach((item) => {
    rootList.appendChild(createOuTreeNode(item, state.selectedOuOuOnly));
  });
}

function createOuTreeNode(item, onlyOu = true) {
  const type = detectType(item);
  const dn = item.dn || item.distinguishedName;
  const li = document.createElement('li');
  li.className = 'ou-tree-item';
  li.dataset.dn = dn;

  const header = document.createElement('div');
  header.className = 'ou-tree-node';
  header.innerHTML = `
    <button type="button" class="btn btn-sm btn-link p-0 me-1 ou-expand-btn ${type === 'ou' ? '' : 'invisible'}">▶</button>
    <button type="button" class="btn btn-link p-0 text-start ou-select-btn">${getTypeBadgeHtml(type)} ${escapeHtml(getDisplayName(item))}</button>
  `;
  li.appendChild(header);

  const childrenWrap = document.createElement('ul');
  childrenWrap.className = 'ou-tree-list d-none';
  li.appendChild(childrenWrap);

  header.querySelector('.ou-select-btn').addEventListener('click', () => {
    document.querySelectorAll('.ou-select-btn.selected').forEach((x) => x.classList.remove('selected'));
    header.querySelector('.ou-select-btn').classList.add('selected');
    state.selectedOuDn = dn;
  });

  header.querySelector('.ou-expand-btn').addEventListener('click', async (event) => {
    event.preventDefault();
    if (type !== 'ou') return;
    const expandBtn = event.currentTarget;
    const expanded = !childrenWrap.classList.contains('d-none');
    if (expanded) {
      childrenWrap.classList.add('d-none');
      expandBtn.textContent = '▶';
      return;
    }
    if (!childrenWrap.dataset.loaded) {
      const children = await fetchOuChildren(dn, onlyOu);
      children.forEach((child) => {
        childrenWrap.appendChild(createOuTreeNode(child, onlyOu));
      });
      childrenWrap.dataset.loaded = '1';
    }
    childrenWrap.classList.remove('d-none');
    expandBtn.textContent = '▼';
  });

  return li;
}

document.getElementById('confirmOuBtn').addEventListener('click', () => {
  if (!state.selectedOuDn || !state.selectedOuInputId) return;
  const input = document.getElementById(state.selectedOuInputId);
  if (input) {
    input.value = state.selectedOuDn;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  ouPickerModal.hide();
});

document.getElementById('confirmSoftDeleteBtn')?.addEventListener('click', async () => {
  if (!state.softDeleteTargetDn) return;
  try {
    await api('/api/object/soft-delete', {
      method: 'POST',
      body: JSON.stringify({ objectDn: state.softDeleteTargetDn })
    });
    softDeleteConfirmModal.hide();
    softDeleteSuccessModal.show();
    showToast('Konto zablokowane i przeniesione do OU zablokowane_konta');
    await runSearch();
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
    await runSearch();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById('groupLookupInput').addEventListener('input', async (event) => {
  const q = event.target.value.trim();
  const box = document.getElementById('groupLookupResults');
  if (q.length < 2) {
    box.innerHTML = '';
    return;
  }
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}&type=group`);
  box.innerHTML = '';
  rows.forEach((row) => renderLookupItem(box, row, async (item) => {
    const pickedDn = item.dn || item.distinguishedName;
    state.pendingChanges.addGroups.add(pickedDn);
    state.pendingChanges.removeGroups.delete(pickedDn);
    const list = document.getElementById('memberOfList');
    if (list && !list.querySelector(`[data-groupdn="${cssEscapeValue(pickedDn)}"]`)) {
      list.querySelector('.text-muted')?.remove();
      list.insertAdjacentHTML('beforeend', renderPendingMemberLine(pickedDn, true));
      list.querySelectorAll('.remove-group-btn').forEach((btn) => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const groupDn = btn.dataset.groupdn;
          state.pendingChanges.removeGroups.add(groupDn);
          state.pendingChanges.addGroups.delete(groupDn);
          btn.closest('.member-of-line')?.classList.add('pending-removal');
        });
      });
    }
    groupSearchModal.hide();
    showToast('Dodano do zmian oczekujących');
  }));
});

document.getElementById('memberLookupInput').addEventListener('input', async (event) => {
  const q = event.target.value.trim();
  const box = document.getElementById('memberLookupResults');
  if (q.length < 2) {
    box.innerHTML = '';
    return;
  }
  const type = document.getElementById('memberLookupType')?.value || 'all';
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
  box.innerHTML = '';
  rows.forEach((row) => renderLookupItem(box, row, (item) => {
    const pickedDn = item.dn || item.distinguishedName;
    if (pickedDn === state.currentObjectDn) {
      showToast('Nie można dodać grupy jako własnego członka', true);
      return;
    }
    state.pendingChanges.addMembers.add(pickedDn);
    state.pendingChanges.removeMembers.delete(pickedDn);
    const list = document.getElementById('membersList');
    if (list && !list.querySelector(`[data-memberdn="${cssEscapeValue(pickedDn)}"]`)) {
      list.querySelector('.text-muted')?.remove();
      list.insertAdjacentHTML('beforeend', renderPendingMemberEntry(pickedDn, true));
      bindModalActions();
    }
    addMemberModal.hide();
    showToast('Dodano do zmian oczekujących');
  }));
});

document.getElementById('referenceLookupInput').addEventListener('input', async (event) => {
  const q = event.target.value.trim();
  const box = document.getElementById('referenceLookupResults');
  if (q.length < 2) {
    box.innerHTML = '';
    return;
  }
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}&type=user`);
  box.innerHTML = '';
  rows.forEach((row) => renderLookupItem(box, row, async (item) => {
    state.referenceUserDn = item.dn || item.distinguishedName;
    const data = await api(`/api/object?dn=${encodeURIComponent(state.referenceUserDn)}`);
    state.copyGroups = Array.isArray(data.memberOf) ? data.memberOf : [];
    document.getElementById('copyGroupsList').innerHTML = state.copyGroups.map((groupDn) => `<div class="form-check"><input class="form-check-input copy-group-check" type="checkbox" checked value="${escapeHtml(groupDn)}"><label class="form-check-label">${escapeHtml(groupDn)}</label></div>`).join('');
    referenceUserModal.hide();
    copyGroupsModal.show();
  }));
});

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
    list.querySelector('.text-muted')?.remove();
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

typeFilter?.addEventListener('change', () => {
  const isOuSelection = typeFilter.value === 'ou-selection';
  searchTextWrap?.classList.toggle('d-none', isOuSelection);
  searchOuWrap?.classList.toggle('d-none', !isOuSelection);
});

searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runSearch();
  }
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
    const data = await api(`/api/reports/stale-logons?years=${years}`);
    reportResult.innerHTML = `<div class="mb-2">Wynik: <strong>${data.length}</strong> kont</div><pre class="json-view">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
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
    await runSearch();
  } catch (error) {
    showToast(error.message, true);
  }
});

const newUserForm = document.getElementById('newUserForm');
const newUserFirstName = document.getElementById('newUserFirstName');
const newUserLastName = document.getElementById('newUserLastName');
const newUserLogin = document.getElementById('newUserLogin');
const newUserLoginStatus = document.getElementById('newUserLoginStatus');
const newUserSubmitBtn = document.getElementById('newUserSubmitBtn');

function setNewUserLoginState(available, message) {
  if (newUserSubmitBtn) newUserSubmitBtn.disabled = !available;
  if (newUserLoginStatus) {
    newUserLoginStatus.textContent = message || '';
    newUserLoginStatus.classList.toggle('text-danger', !available && Boolean(message));
    newUserLoginStatus.classList.toggle('text-success', available);
  }
}

async function checkNewUserLoginAvailability() {
  const login = newUserLogin?.value.trim() || '';
  if (!login) {
    setNewUserLoginState(false, '');
    return;
  }
  try {
    setNewUserLoginState(false, 'Sprawdzanie dostępności…');
    const result = await api(`/api/user/login-availability?login=${encodeURIComponent(login)}`);
    setNewUserLoginState(Boolean(result.available), result.available ? 'Login dostępny.' : 'Login zajęty — wybierz inny.');
  } catch (error) {
    setNewUserLoginState(false, error.message);
  }
}

async function autoFillNewUserLogin() {
  const firstName = newUserFirstName?.value.trim() || '';
  const lastName = newUserLastName?.value.trim() || '';
  if (!firstName || !lastName) {
    if (newUserLogin) newUserLogin.value = '';
    setNewUserLoginState(false, '');
    return;
  }
  try {
    setNewUserLoginState(false, 'Sprawdzanie dostępności…');
    const result = await api(`/api/user/suggest-login?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}`);
    if (newUserLogin) newUserLogin.value = result.login || '';
    setNewUserLoginState(Boolean(result.available), result.available ? 'Login dostępny.' : 'Nie udało się znaleźć wolnego loginu — wybierz ręcznie.');
  } catch (error) {
    setNewUserLoginState(false, error.message);
  }
}

const debouncedAutoFillNewUserLogin = debounce(autoFillNewUserLogin, 350);
const debouncedCheckNewUserLoginAvailability = debounce(checkNewUserLoginAvailability, 350);

newUserFirstName?.addEventListener('input', debouncedAutoFillNewUserLogin);
newUserLastName?.addEventListener('input', debouncedAutoFillNewUserLogin);
newUserLogin?.addEventListener('input', debouncedCheckNewUserLoginAvailability);

document.getElementById('newUserModal')?.addEventListener('show.bs.modal', () => {
  setNewUserLoginState(false, '');
});

newUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    payload.mustChangePasswordAtNextLogon = parseTruthy(payload.mustChangePasswordAtNextLogon);
    payload.userCannotChangePassword = parseTruthy(payload.userCannotChangePassword);
    payload.passwordNeverExpires = parseTruthy(payload.passwordNeverExpires);
    payload.accountDisabled = parseTruthy(payload.accountDisabled);
    payload.accountExpiresMode = payload.accountExpiresModeNewUser || 'never';
    delete payload.accountExpiresModeNewUser;
    await api('/api/user/create', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Użytkownik utworzony');
    event.target.reset();
    setNewUserLoginState(false, '');
  } catch (error) {
    showToast(error.message, true);
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

document.getElementById('newGroupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    await api('/api/group/create', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Grupa utworzona');
    event.target.reset();
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

document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
  // eslint-disable-next-line no-new
  new bootstrap.Popover(el, { trigger: 'click', html: true });
});

bindOuPickers();
loadDashboardStats();
loadGlobalAuditWidgets();
initPortalActivityActions();
switchReportPage(state.activeReportPage);
