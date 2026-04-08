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
  if (cls.includes('computer')) return 'computer';
  if (cls.includes('group')) return 'group';
  return 'user';
}

function renderResultItem(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'list-group-item list-group-item-action';
  const type = detectType(item);
  button.innerHTML = `<strong>${item.displayName || item.cn || item.sAMAccountName}</strong> <span class="badge text-bg-secondary ms-2">${type}</span><div class="small text-muted">${item.distinguishedName || item.dn}</div>`;
  button.addEventListener('click', () => openObject(item.dn || item.distinguishedName, type));
  return button;
}

async function runSearch() {
  try {
    const q = encodeURIComponent(searchInput.value || '');
    const type = encodeURIComponent(typeFilter.value);
    const data = await api(`/api/search?q=${q}&type=${type}`);
    results.innerHTML = '';
    data.forEach((row) => results.appendChild(renderResultItem(row)));
    if (!data.length) results.innerHTML = '<div class="text-muted">Brak wyników</div>';
  } catch (error) {
    showToast(error.message, true);
  }
}

function tabsTemplate(tabs) {
  const nav = tabs.map((t, i) => `<li class="nav-item"><button class="nav-link ${i === 0 ? 'active' : ''}" data-bs-toggle="tab" data-bs-target="#${t.id}">${t.title}</button></li>`).join('');
  const content = tabs.map((t, i) => `<div class="tab-pane fade ${i === 0 ? 'show active' : ''} p-2" id="${t.id}">${t.content}</div>`).join('');
  return `<ul class="nav nav-tabs">${nav}</ul><div class="tab-content border border-top-0 rounded-bottom">${content}</div>`;
}

function userTemplate(data) {
  return tabsTemplate([
    { id: 'u-data', title: 'Dane', content: `<pre class="json-view">${escapeHtml(JSON.stringify(data, null, 2))}</pre>` },
    { id: 'u-memberof', title: 'Member Of', content: memberOfTemplate(data) },
    { id: 'u-ou', title: 'OU / Przeniesienie', content: moveTemplate(data.distinguishedName || data.dn) }
  ]);
}

function computerTemplate(data) {
  return tabsTemplate([
    { id: 'c-data', title: 'Parametry komputera', content: `<pre class="json-view">${escapeHtml(JSON.stringify(data, null, 2))}</pre>` },
    { id: 'c-ou', title: 'OU / Przeniesienie', content: moveTemplate(data.distinguishedName || data.dn) }
  ]);
}

function groupTemplate(data) {
  const members = Array.isArray(data.member) ? data.member : data.member ? [data.member] : [];
  return tabsTemplate([
    { id: 'g-members', title: 'Członkowie', content: `<div class="mb-2">Liczba członków: <strong>${members.length}</strong></div><pre class="json-view">${escapeHtml(JSON.stringify(members, null, 2))}</pre>` },
    { id: 'g-inheritance', title: 'Dziedziczenie', content: '<div class="alert alert-info">W AD dziedziczenie ACL wymaga osobnego modułu (możesz rozbudować w services/ad).</div>' }
  ]);
}

function memberOfTemplate(data) {
  const groups = Array.isArray(data.memberOf) ? data.memberOf : [];
  const groupList = groups.map((g) => `<div class="form-check"><input class="form-check-input group-checkbox" type="checkbox" value="${g}" checked><label class="form-check-label">${g}</label></div>`).join('');

  return `
    <div class="mb-2">
      <label class="form-label">Szukaj grupy i dodaj po DN</label>
      <div class="input-group mb-2">
        <input id="groupSearchDn" class="form-control" placeholder="CN=...,OU=Groups,DC=..." />
        <button class="btn btn-outline-primary" id="addGroupBtn" data-userdn="${data.distinguishedName || data.dn}">Dodaj</button>
      </div>
    </div>
    <div class="mb-2">
      <label class="form-label">Kopiowanie grup z użytkownika referencyjnego (DN)</label>
      <div class="input-group mb-2">
        <input id="referenceDn" class="form-control" placeholder="CN=Jan Kowalski,OU=Users,..." />
        <button class="btn btn-outline-secondary" id="copyGroupsBtn" data-userdn="${data.distinguishedName || data.dn}">Kopiuj zaznaczone</button>
      </div>
    </div>
    <div id="groupsArea">${groupList || '<span class="text-muted">Brak grup</span>'}</div>
  `;
}

function moveTemplate(objectDn) {
  return `
    <label class="form-label">Nowe OU DN</label>
    <div class="input-group">
      <input id="newOuDn" class="form-control" placeholder="OU=NowaOU,DC=hospital,DC=local" />
      <button id="moveObjectBtn" data-objdn="${objectDn}" class="btn btn-warning">Przenieś obiekt</button>
    </div>
  `;
}

async function openObject(dn, typeHint) {
  try {
    const data = await api(`/api/object?dn=${encodeURIComponent(dn)}`);
    const type = typeHint || detectType(data);
    objectTitle.textContent = `${data.displayName || data.cn || data.sAMAccountName} (${type})`;
    objectBody.innerHTML = type === 'computer' ? computerTemplate(data) : type === 'group' ? groupTemplate(data) : userTemplate(data);
    bindModalActions();
    objectModal.show();
  } catch (error) {
    showToast(error.message, true);
  }
}

function selectedGroups() {
  return Array.from(document.querySelectorAll('.group-checkbox:checked')).map((x) => x.value);
}

function bindModalActions() {
  document.getElementById('addGroupBtn')?.addEventListener('click', async () => {
    try {
      const userDn = document.getElementById('addGroupBtn').dataset.userdn;
      const groupDn = document.getElementById('groupSearchDn').value;
      await api('/api/user/groups', { method: 'POST', body: JSON.stringify({ userDn, addDns: [groupDn] }) });
      showToast('Dodano grupę');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.getElementById('copyGroupsBtn')?.addEventListener('click', async () => {
    try {
      const targetUserDn = document.getElementById('copyGroupsBtn').dataset.userdn;
      const referenceUserDn = document.getElementById('referenceDn').value;
      await api('/api/user/groups/copy', {
        method: 'POST',
        body: JSON.stringify({ targetUserDn, referenceUserDn, selectedGroups: selectedGroups() })
      });
      showToast('Skopiowano grupy');
    } catch (error) {
      showToast(error.message, true);
    }
  });

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
}

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
    const formData = new FormData(event.target);
    const payload = Object.fromEntries(formData.entries());
    await api('/api/user/create', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Użytkownik utworzony');
    event.target.reset();
  } catch (error) {
    showToast(error.message, true);
  }
});

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
