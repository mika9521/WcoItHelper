const searchBtn = document.getElementById('searchBtn');
const results = document.getElementById('results');
const typeFilter = document.getElementById('typeFilter');
const searchInput = document.getElementById('searchInput');
const objectBody = document.getElementById('objectBody');
const objectTitle = document.getElementById('objectTitle');
const loadReportBtn = document.getElementById('loadReportBtn');
const reportResult = document.getElementById('reportResult');

const toast = new bootstrap.Toast(document.getElementById('appToast'));
const objectModal = new bootstrap.Modal(document.getElementById('objectModal'));
const groupSearchModal = new bootstrap.Modal(document.getElementById('groupSearchModal'));
const referenceUserModal = new bootstrap.Modal(document.getElementById('referenceUserModal'));
const copyGroupsModal = new bootstrap.Modal(document.getElementById('copyGroupsModal'));
const ouPickerModal = new bootstrap.Modal(document.getElementById('ouPickerModal'));

const state = {
  currentUserDn: null,
  referenceUserDn: null,
  copyGroups: [],
  selectedOuInputId: null,
  selectedOuDn: null
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

function getTypeIcon(type) {
  return { user: '👤', computer: '🖥️', group: '🛡️', ou: '📁' }[type] || '📄';
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

function renderResultItem(item) {
  const tr = document.createElement('tr');
  const type = detectType(item);
  const dn = item.dn || item.distinguishedName;
  tr.innerHTML = `
    <td>${getTypeIcon(type)}</td>
    <td><button type="button" class="btn btn-link p-0 object-link">${item.displayName || item.cn || item.sAMAccountName || '-'}</button><div class="small text-muted">${getTypeLabel(type)}</div></td>
    <td class="small">${dn || '-'}</td>
    <td>
      <div class="d-flex gap-1 justify-content-end">
        <button class="btn btn-sm btn-outline-primary action-open" title="Szczegóły">🔎</button>
        <button class="btn btn-sm btn-outline-warning action-move" title="Przenieś">📦</button>
        ${type === 'user' ? '<button class="btn btn-sm btn-outline-danger action-toggle" title="Włącz/Wyłącz">🔒</button>' : ''}
      </div>
    </td>
  `;

  tr.querySelector('.object-link').addEventListener('click', () => openObject(dn, type));
  tr.querySelector('.action-open').addEventListener('click', () => openObject(dn, type));
  tr.querySelector('.action-move').addEventListener('click', () => openMoveOnly(dn, item.displayName || item.cn || dn));
  tr.querySelector('.action-toggle')?.addEventListener('click', () => toggleUser(dn));
  return tr;
}

async function runSearch() {
  try {
    const q = encodeURIComponent(searchInput.value || '');
    const type = encodeURIComponent(typeFilter.value);
    const data = await api(`/api/search?q=${q}&type=${type}`);
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
  return `<table class="table table-sm table-striped"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td><div class="input-group input-group-sm"><span class="input-group-text">${k}</span><input class="form-control" readonly value="${escapeHtml(v || '-')}" /></div></td></tr>`).join('')}</tbody></table>`;
}

function userTemplate(data) {
  return tabsTemplate([
    { id: 'u-data', title: 'Dane', content: dataTableTemplate(data) },
    { id: 'u-memberof', title: 'Członek grup', content: memberOfTemplate(data) },
    { id: 'u-ou', title: 'OU / Przeniesienie', content: moveTemplate(data.distinguishedName || data.dn) }
  ]);
}

function computerTemplate(data) {
  return tabsTemplate([
    { id: 'c-data', title: 'Dane komputera', content: dataTableTemplate(data) },
    { id: 'c-ou', title: 'OU / Przeniesienie', content: moveTemplate(data.distinguishedName || data.dn) }
  ]);
}

function groupTemplate(data) {
  const members = Array.isArray(data.member) ? data.member : data.member ? [data.member] : [];
  return tabsTemplate([
    { id: 'g-data', title: 'Dane', content: dataTableTemplate(data) },
    { id: 'g-members', title: 'Członkowie', content: `<div class="mb-2">Liczba członków: <strong>${members.length}</strong></div>${members.map((m) => `<span class="badge text-bg-secondary me-1 mb-1">${escapeHtml(m)}</span>`).join('') || '<span class="text-muted">Brak członków</span>'}` }
  ]);
}

function memberOfTemplate(data) {
  const groups = Array.isArray(data.memberOf) ? data.memberOf : [];
  return `
    <div class="mb-2 d-flex flex-wrap gap-2">
      ${groups.map((g) => `<span class="badge text-bg-info group-badge">${escapeHtml(g)}</span>`).join('') || '<span class="text-muted">Brak grup</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddGroupModal" data-userdn="${data.distinguishedName || data.dn}">Dodaj</button>
      <button class="btn btn-outline-secondary btn-sm" id="openReferenceModal" data-userdn="${data.distinguishedName || data.dn}">Inny użytkownik</button>
    </div>
  `;
}

function moveTemplate(objectDn) {
  return `
    <label class="form-label">Nowe OU DN</label>
    <div class="input-group">
      <input id="newOuDn" class="form-control" placeholder="Wybierz OU..." readonly />
      <button class="btn btn-outline-secondary pick-ou-btn" data-target-input="newOuDn">Wybierz OU</button>
      <button id="moveObjectBtn" data-objdn="${objectDn}" class="btn btn-warning">Przenieś obiekt</button>
    </div>
  `;
}

async function openObject(dn, typeHint) {
  try {
    const data = await api(`/api/object?dn=${encodeURIComponent(dn)}`);
    const type = typeHint || detectType(data);
    objectTitle.textContent = `${data.displayName || data.cn || data.sAMAccountName} (${getTypeLabel(type)})`;
    objectBody.innerHTML = type === 'computer' ? computerTemplate(data) : type === 'group' ? groupTemplate(data) : userTemplate(data);
    bindModalActions();
    objectModal.show();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openMoveOnly(dn, label) {
  objectTitle.textContent = `Przeniesienie: ${label}`;
  objectBody.innerHTML = moveTemplate(dn);
  bindModalActions();
  objectModal.show();
}

async function toggleUser(userDn) {
  try {
    await api('/api/user/enabled', { method: 'POST', body: JSON.stringify({ userDn, enabled: false }) });
    showToast('Użytkownik został wyłączony/zablokowany');
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderLookupItem(container, item, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const type = detectType(item);
  btn.className = 'list-group-item list-group-item-action';
  btn.innerHTML = `${getTypeIcon(type)} ${escapeHtml(item.displayName || item.cn || item.sAMAccountName)}<div class="small text-muted">${escapeHtml(item.dn || item.distinguishedName || '')}</div>`;
  btn.addEventListener('click', () => onPick(item));
  container.appendChild(btn);
}

function bindModalActions() {
  document.getElementById('moveObjectBtn')?.addEventListener('click', async () => {
    try {
      const objectDn = document.getElementById('moveObjectBtn').dataset.objdn;
      const newParentOuDn = document.getElementById('newOuDn').value;
      await api('/api/object/move', { method: 'POST', body: JSON.stringify({ objectDn, newParentOuDn }) });
      showToast('Przeniesiono obiekt');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.getElementById('openAddGroupModal')?.addEventListener('click', () => {
    state.currentUserDn = document.getElementById('openAddGroupModal').dataset.userdn;
    document.getElementById('groupLookupInput').value = '';
    document.getElementById('groupLookupResults').innerHTML = '';
    groupSearchModal.show();
  });

  document.getElementById('openReferenceModal')?.addEventListener('click', () => {
    state.currentUserDn = document.getElementById('openReferenceModal').dataset.userdn;
    document.getElementById('referenceLookupInput').value = '';
    document.getElementById('referenceLookupResults').innerHTML = '';
    referenceUserModal.show();
  });

  bindOuPickers();
}

function bindOuPickers() {
  document.querySelectorAll('.pick-ou-btn').forEach((btn) => {
    btn.onclick = async () => {
      state.selectedOuInputId = btn.dataset.targetInput;
      state.selectedOuDn = null;
      await loadOuLevel();
      ouPickerModal.show();
    };
  });
}

async function loadOuLevel(parentDn = '') {
  const tree = document.getElementById('ouTree');
  const data = await api(`/api/ou-children${parentDn ? `?parentDn=${encodeURIComponent(parentDn)}` : ''}`);
  tree.innerHTML = data.map((item) => {
    const type = detectType(item);
    const dn = item.dn || item.distinguishedName;
    return `<button class="list-group-item list-group-item-action ou-node" data-dn="${escapeHtml(dn)}">${getTypeIcon(type)} ${escapeHtml(item.displayName || item.cn || dn)}<div class="small text-muted">${escapeHtml(dn)}</div></button>`;
  }).join('');

  tree.querySelectorAll('.ou-node').forEach((el) => {
    el.addEventListener('click', async () => {
      const dn = el.dataset.dn;
      state.selectedOuDn = dn;
      if (detectDnTypeByText(el.textContent) === 'ou') {
        await loadOuLevel(dn);
      }
    });
  });
}

function detectDnTypeByText(text) {
  if (text.includes('📁')) return 'ou';
  if (text.includes('👤')) return 'user';
  if (text.includes('🖥️')) return 'computer';
  if (text.includes('🛡️')) return 'group';
  return 'other';
}

document.getElementById('confirmOuBtn').addEventListener('click', () => {
  if (!state.selectedOuDn || !state.selectedOuInputId) return;
  document.getElementById(state.selectedOuInputId).value = state.selectedOuDn;
  ouPickerModal.hide();
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
    await api('/api/user/groups', { method: 'POST', body: JSON.stringify({ userDn: state.currentUserDn, addDns: [item.dn || item.distinguishedName] }) });
    groupSearchModal.hide();
    showToast('Dodano grupę');
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
  await api('/api/user/groups/copy', {
    method: 'POST',
    body: JSON.stringify({ targetUserDn: state.currentUserDn, referenceUserDn: state.referenceUserDn, selectedGroups })
  });
  copyGroupsModal.hide();
  showToast('Skopiowano grupy');
});

searchBtn.addEventListener('click', runSearch);
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

document.getElementById('newUserForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(event.target).entries());
    await api('/api/user/create', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Użytkownik utworzony');
    event.target.reset();
  } catch (error) {
    showToast(error.message, true);
  }
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

bindOuPickers();
