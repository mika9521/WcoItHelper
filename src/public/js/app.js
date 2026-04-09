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
const statUsers = document.getElementById('statUsers');
const statGroups = document.getElementById('statGroups');
const statComputers = document.getElementById('statComputers');
const statOus = document.getElementById('statOus');
const statTotal = document.getElementById('statTotal');

const toast = new bootstrap.Toast(document.getElementById('appToast'));
const objectModal = new bootstrap.Modal(document.getElementById('objectModal'));
const groupSearchModal = new bootstrap.Modal(document.getElementById('groupSearchModal'));
const referenceUserModal = new bootstrap.Modal(document.getElementById('referenceUserModal'));
const copyGroupsModal = new bootstrap.Modal(document.getElementById('copyGroupsModal'));
const ouPickerModal = new bootstrap.Modal(document.getElementById('ouPickerModal'));
const applyObjectChangesBtn = document.getElementById('applyObjectChangesBtn');

const state = {
  currentUserDn: null,
  referenceUserDn: null,
  copyGroups: [],
  selectedOuInputId: null,
  selectedOuOuOnly: true,
  selectedOuDn: null,
  currentObjectDn: null,
  pendingChanges: null,
  ouTreeCache: new Map()
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

function getDisplayName(item) {
  const type = detectType(item);
  if (type === 'group') return item.cn || item.displayName || item.sAMAccountName || '-';
  return item.displayName || item.cn || item.sAMAccountName || '-';
}

function isAccountDisabled(item) {
  const type = detectType(item);
  if (type !== 'user' && type !== 'computer') return false;
  const flag = Number(item.userAccountControl || 0);
  return (flag & 2) === 2;
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
  const name = getDisplayName(item);
  const disabled = isAccountDisabled(item);
  if (disabled) tr.classList.add('table-warning');

  const openDetails = () => {
    document.querySelectorAll('#results tr.result-active').forEach((row) => row.classList.remove('result-active'));
    tr.classList.add('result-active');
    openObject(dn, type);
  };

  tr.innerHTML = `
    <td><button type="button" class="btn btn-link p-0 type-open-btn" title="Szczegóły">${getTypeIcon(type)}</button></td>
    <td><button type="button" class="btn btn-link p-0 object-link">${name}</button><div class="small text-muted">${getTypeLabel(type)}</div></td>
    <td class="small">${dn || '-'}</td>
    <td>
      <div class="d-flex gap-1 justify-content-end">
        <button class="btn btn-sm btn-outline-primary action-open" title="Szczegóły">🔎</button>
        <button class="btn btn-sm btn-outline-warning action-move" title="Przenieś">📦</button>
        ${(type === 'user' || type === 'computer') ? '<button class="btn btn-sm btn-outline-danger action-toggle" title="Włącz/Wyłącz">🔒</button>' : ''}
      </div>
    </td>
  `;

  tr.querySelector('.type-open-btn').addEventListener('click', openDetails);
  tr.querySelector('.object-link').addEventListener('click', openDetails);
  tr.querySelector('.action-open').addEventListener('click', openDetails);
  tr.querySelector('.action-move').addEventListener('click', () => openMoveOnly(dn, item.displayName || item.cn || dn));
  tr.querySelector('.action-toggle')?.addEventListener('click', () => toggleUser(dn));
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

function userTemplate(data) {
  return tabsTemplate([
    { id: 'u-data', title: 'Dane', content: dataTableTemplate(data) },
    { id: 'u-memberof', title: 'Członek grup', content: memberOfTemplate(data) }
  ]);
}

function computerTemplate(data) {
  return tabsTemplate([
    { id: 'c-data', title: 'Dane komputera', content: dataTableTemplate(data) }
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
  const userDn = data.distinguishedName || data.dn;
  return `
    <div class="mb-2 group-member-list" id="memberOfList" data-userdn="${escapeHtml(userDn)}">
      ${groups.map((g) => `<div class="member-of-line" data-groupdn="${escapeHtml(g)}"><span class="badge text-bg-info group-badge">${escapeHtml(g)}</span><button type="button" class="btn btn-sm btn-outline-danger remove-group-btn ms-2" data-groupdn="${escapeHtml(g)}">✕</button></div>`).join('') || '<span class="text-muted">Brak grup</span>'}
    </div>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-primary btn-sm" id="openAddGroupModal" data-userdn="${userDn}">Dodaj</button>
      <button class="btn btn-outline-secondary btn-sm" id="openReferenceModal" data-userdn="${userDn}">Inny użytkownik</button>
    </div>
  `;
}

function renderPendingMemberLine(groupDn, pendingAdd = false) {
  const badgeClass = pendingAdd ? 'text-bg-warning text-dark' : 'text-bg-info';
  return `<div class="member-of-line ${pendingAdd ? 'pending-added' : ''}" data-groupdn="${escapeHtml(groupDn)}"><span class="badge ${badgeClass} group-badge">${escapeHtml(groupDn)}</span><button type="button" class="btn btn-sm btn-outline-danger remove-group-btn ms-2" data-groupdn="${escapeHtml(groupDn)}">✕</button></div>`;
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
    objectTitle.textContent = `${data.displayName || data.cn || data.sAMAccountName} (${getTypeLabel(type)})`;
    objectBody.innerHTML = type === 'computer' ? computerTemplate(data) : type === 'group' ? groupTemplate(data) : userTemplate(data);
    state.currentObjectDn = data.distinguishedName || data.dn || dn;
    state.pendingChanges = { addGroups: new Set(), removeGroups: new Set(), moveTargetDn: null };
    applyObjectChangesBtn.classList.toggle('d-none', type === 'group');
    bindModalActions();
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

async function toggleUser(userDn) {
  try {
    await api('/api/object/enabled', { method: 'POST', body: JSON.stringify({ objectDn: userDn, enabled: false }) });
    showToast('Obiekt został wyłączony/zablokowany');
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

  document.getElementById('newOuDn')?.addEventListener('change', (event) => {
    state.pendingChanges.moveTargetDn = event.target.value || null;
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
    <button type="button" class="btn btn-link p-0 text-start ou-select-btn">${getTypeIcon(type)} ${escapeHtml(item.displayName || item.cn || item.sAMAccountName || dn.split(',')[0].replace(/^[A-Z]+=/i, ''))}</button>
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
  document.getElementById(state.selectedOuInputId).value = state.selectedOuDn;
  state.pendingChanges.moveTargetDn = state.selectedOuDn;
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
    const moveTargetDn = state.pendingChanges?.moveTargetDn;

    if (addDns.length || removeDns.length) {
      operations.push(api('/api/user/groups', {
        method: 'POST',
        body: JSON.stringify({ userDn: state.currentObjectDn, addDns, removeDns })
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

function cssEscapeValue(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replaceAll('"', '\\"');
}

bindOuPickers();
loadDashboardStats();
