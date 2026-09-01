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

  const head = document.getElementById('suppliersHead');
  head.innerHTML = '<th>Name</th>' + days.map(d => `<th>${d.label} spaces left</th>`).join('');

  const tbody = document.querySelector('#suppliersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('suppliersEmpty').style.display = suppliers.length ? 'none' : 'block';

  for (const s of suppliers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><button class="link-action" data-supplier="${s.id}">${s.name}</button></td>` +
      s.days.map(d => `<td>${d.available}</td>`).join('');
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-supplier]').forEach(btn => {
    btn.addEventListener('click', () => showSupplierDetail(btn.dataset.supplier));
  });
}

async function loadMembers() {
  const { days, members } = await api('GET', '/api/admin/members');

  const head = document.getElementById('membersHead');
  head.innerHTML = '<th>Name</th>' + days.map(d => `<th>${d.label} booked</th>`).join('');

  const tbody = document.querySelector('#membersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('membersEmpty').style.display = members.length ? 'none' : 'block';

  for (const m of members) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><button class="link-action" data-member="${m.id}">${m.company || m.name}</button></td>` +
      m.days.map(d => `<td>${d.booked}</td>`).join('');
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-member]').forEach(btn => {
    btn.addEventListener('click', () => showMemberDetail(btn.dataset.member));
  });
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
      div.innerHTML = s.status === 'booked'
        ? `${s.start_time}<small>${s.member_name}</small>`
        : `${s.start_time}<small>${s.status}</small>`;
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
})();
