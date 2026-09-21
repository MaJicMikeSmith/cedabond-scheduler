function formatUKDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

function formatDayAbbr(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase().slice(0, 3);
}

async function loadSuppliers() {
  const { days, suppliers } = await api('GET', '/api/admin/suppliers');

  ensureLockControls('suppliersTable', 'supplier');

  const head = document.getElementById('suppliersHead');
  head.innerHTML = '<th>Locked</th><th>Name</th>' + days.map(d => `<th>${d.label} spaces left</th>`).join('') + '<th></th>';

  const tbody = document.querySelector('#suppliersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('suppliersEmpty').style.display = suppliers.length ? 'none' : 'block';

  for (const s of suppliers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" data-lock-supplier="${s.id}" ${s.locked ? 'checked' : ''}></td>` +
      `<td><button class="link-action" data-supplier="${s.id}">${s.name}</button></td>` +
      s.days.map(d => `<td>${d.available}</td>`).join('') +
      `<td><button class="secondary small" data-manage-supplier="${s.id}">Manage as</button></td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-supplier]').forEach(btn => {
    btn.addEventListener('click', () => showSupplierDetail(btn.dataset.supplier));
  });

  tbody.querySelectorAll('button[data-manage-supplier]').forEach(btn => {
    btn.addEventListener('click', () => manageAs('supplier', btn.dataset.manageSupplier));
  });

  tbody.querySelectorAll('input[data-lock-supplier]').forEach(cb => {
    cb.addEventListener('change', () => setLocked('supplier', cb.dataset.lockSupplier, cb.checked));
  });
}

async function loadMembers() {
  const { days, members } = await api('GET', '/api/admin/members');

  ensureLockControls('membersTable', 'member');

  const head = document.getElementById('membersHead');
  head.innerHTML = '<th>Locked</th><th>Name</th>' + days.map(d => `<th>${d.label} booked</th>`).join('') + '<th></th>';

  const tbody = document.querySelector('#membersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('membersEmpty').style.display = members.length ? 'none' : 'block';

  for (const m of members) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" data-lock-member="${m.id}" ${m.locked ? 'checked' : ''}></td>` +
      `<td><button class="link-action" data-member="${m.id}">${m.company || m.name}</button></td>` +
      m.days.map(d => `<td>${d.booked}</td>`).join('') +
      `<td><button class="secondary small" data-manage-member="${m.id}">Manage as</button></td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-member]').forEach(btn => {
    btn.addEventListener('click', () => showMemberDetail(btn.dataset.member));
  });

  tbody.querySelectorAll('button[data-manage-member]').forEach(btn => {
    btn.addEventListener('click', () => manageAs('member', btn.dataset.manageMember));
  });

  tbody.querySelectorAll('input[data-lock-member]').forEach(cb => {
    cb.addEventListener('change', () => setLocked('member', cb.dataset.lockMember, cb.checked));
  });
}

// Toggle a single member's/supplier's locked state via their row checkbox.
async function setLocked(role, id, locked) {
  try {
    await api('POST', '/api/admin/lock', { role, id: Number(id), locked });
    showToast(locked ? 'Account locked' : 'Account unlocked');
  } catch (err) {
    showToast(err.message);
    // Re-fetch to put the checkbox back in sync with the real state.
    if (role === 'supplier') loadSuppliers(); else loadMembers();
  }
}

// Adds a "Lock all / Unlock all" control bar directly above the given table,
// once - safe to call on every refresh without duplicating it.
function ensureLockControls(tableId, role) {
  const table = document.getElementById(tableId);
  const barId = `${tableId}-lockControls`;
  if (document.getElementById(barId)) return;

  const bar = document.createElement('div');
  bar.id = barId;
  bar.style.cssText = 'margin-bottom:10px; display:flex; gap:8px;';
  bar.innerHTML = `
    <button class="secondary small" data-lock-all="${role}">Lock all</button>
    <button class="secondary small" data-unlock-all="${role}">Unlock all</button>
  `;
  table.parentNode.insertBefore(bar, table);

  bar.querySelector('[data-lock-all]').addEventListener('click', async () => {
    if (!confirm(`Lock every ${role} so none of them can make changes?`)) return;
    try {
      await api('POST', '/api/admin/lock-all', { role, locked: true });
      showToast(`All ${role}s locked`);
      if (role === 'supplier') loadSuppliers(); else loadMembers();
    } catch (err) {
      showToast(err.message);
    }
  });

  bar.querySelector('[data-unlock-all]').addEventListener('click', async () => {
    if (!confirm(`Unlock every ${role} so they can make changes again?`)) return;
    try {
      await api('POST', '/api/admin/lock-all', { role, locked: false });
      showToast(`All ${role}s unlocked`);
      if (role === 'supplier') loadSuppliers(); else loadMembers();
    } catch (err) {
      showToast(err.message);
    }
  });
}

// Switches this admin session into the chosen member's/supplier's account
// (no password needed) so admin can manage their bookings directly. A
// "Return to Admin" button appears on their portal to switch back.
async function manageAs(role, id) {
  try {
    const { redirect } = await api('POST', '/api/admin/impersonate', { role, id: Number(id) });
    window.location.href = redirect;
  } catch (err) {
    showToast(err.message);
  }
}

function openDetail(heading) {
  document.getElementById('detailHeading').textContent = heading;
  const card = document.getElementById('detailCard');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('detailClose').addEventListener('click', () => {
  document.getElementById('detailCard').style.display = 'none';
});

async function showSupplierDetail(id) {
  const { supplier, slots } = await api('GET', `/api/admin/suppliers/${id}`);
  openDetail(supplier.company || supplier.name);

  const byDay = new Map();
  for (const s of slots) {
    if (!byDay.has(s.day_id)) byDay.set(s.day_id, { label: s.day_label, date: s.day_date, slots: [] });
    byDay.get(s.day_id).slots.push(s);
  }

  const body = document.getElementById('detailBody');
  body.innerHTML = '';
  for (const { label, date, slots: daySlots } of byDay.values()) {
    const heading = document.createElement('h3');
    heading.className = 'day-heading';
    heading.textContent = `${label} - ${formatDayAbbr(date)} (${formatUKDate(date)})`;
    body.appendChild(heading);

    const wrap = document.createElement('div');
    wrap.className = 'slot-grid';
    for (const s of daySlots) {
      const div = document.createElement('div');
      div.className = `slot ${s.status}`;
      // A blocked slot may carry a note (e.g. who's actually in a manually-
      // arranged group meeting) - show one member per line instead of just
      // "blocked" when present, rather than one run-on comma-separated line.
      const detail = s.status === 'booked' ? s.member_name : (s.note ? s.note.split(', ').join('<br>') : s.status);
      div.innerHTML = `${s.start_time}<small>${detail}</small>`;
      wrap.appendChild(div);
    }
    body.appendChild(wrap);
  }
}

async function showMemberDetail(id) {
  const { member, bookings } = await api('GET', `/api/admin/members/${id}`);
  openDetail(member.company || member.name);

  const body = document.getElementById('detailBody');
  if (!bookings.length) {
    body.innerHTML = '<p class="empty">No confirmed meetings yet.</p>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Day</th><th>Time</th><th>Supplier</th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  for (const b of bookings) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${b.day_label} - ${formatDayAbbr(b.day_date)}</td><td>${b.start_time}\u2013${b.end_time}</td><td>${b.supplier_name}</td>`;
    tbody.appendChild(tr);
  }
  body.innerHTML = '';
  body.appendChild(table);
}

(async function init() {
  await Promise.all([loadSuppliers(), loadMembers()]);

  // Keep the dashboard current without needing a manual reload - this page has no
  // real-time push connection like the member/supplier portals do.
  setInterval(() => {
    loadSuppliers();
    loadMembers();
  }, 60000);
})();
