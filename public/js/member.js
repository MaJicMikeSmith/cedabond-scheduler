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

let pendingRequestsBySupplier = {};

async function loadRequests() {
  const requests = await api('GET', '/api/member/requests');
  pendingRequestsBySupplier = {};
  for (const r of requests) if (r.status === 'pending' || r.status === 'booked') pendingRequestsBySupplier[r.supplier_id] = r.id;

  // Once a request is confirmed (booked), it moves down to "Meetings
  // confirmed" and drops out of this list entirely.
  const openRequests = requests.filter(r => r.status !== 'booked');

  const tbody = document.querySelector('#requestsTable tbody');
  tbody.innerHTML = '';
  document.getElementById('requestsEmpty').style.display = openRequests.length ? 'none' : 'block';

  for (const r of openRequests) {
    const tr = document.createElement('tr');
    const dateCell = r.booked_date ? formatDayAbbr(r.booked_date) : '';
    const timeCell = r.booked_start_time ? `${r.booked_start_time}\u2013${r.booked_end_time}` : '';
    const statusCell = r.status === 'pending'
      ? `<button class="pill pending" data-view="${r.supplier_id}" title="Click to view and book their available slots">Requested</button>` +
        ` <button class="secondary small" data-decline="${r.id}">Decline</button>`
      : `<span class="pill ${r.status}">${r.status}</span>`;
    tr.innerHTML = `<td>${r.supplier_name}</td><td>${dateCell}</td><td>${timeCell}</td>` +
      `<td>${statusCell}</td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('supplierSelect').value = btn.dataset.view;
      loadSlots(btn.dataset.view);
      document.getElementById('supplierSelect').scrollIntoView({ behavior: 'smooth' });
    });
  });

  tbody.querySelectorAll('button[data-decline]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Decline this meeting request? The supplier will be notified and can request someone else instead.')) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/member/requests/${btn.dataset.decline}/decline`);
        showToast('Request declined');
        await Promise.all([loadRequests(), loadSuppliers()]);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadSuppliers() {
  const suppliers = await api('GET', '/api/member/suppliers');
  const requesting = suppliers.filter(s => s.has_request);
  const others = suppliers.filter(s => !s.has_request);

  const select = document.getElementById('supplierSelect');
  if (!requesting.length) {
    select.innerHTML = '<option value="">No suppliers have requested a meeting with you yet</option>';
    select.disabled = true;
  } else {
    select.disabled = false;
    select.innerHTML = '<option value="">Select a supplier…</option>' +
      requesting.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }

  const otherList = document.getElementById('otherSuppliersList');
  const otherEmpty = document.getElementById('otherSuppliersEmpty');
  otherList.innerHTML = '';
  otherEmpty.style.display = others.length ? 'none' : 'block';
  for (const s of others) {
    const li = document.createElement('li');
    li.innerHTML = `<button class="link-action" data-browse="${s.id}">${s.name}</button>`;
    otherList.appendChild(li);
  }
  otherList.querySelectorAll('button[data-browse]').forEach(btn => {
    btn.addEventListener('click', () => {
      select.value = ''; // this supplier isn't in the "requested" dropdown
      loadSlots(btn.dataset.browse);
      document.getElementById('slotGrid').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

document.getElementById('supplierSelect').addEventListener('change', function () {
  loadSlots(this.value);
});

async function loadSlots(supplierId) {
  const grid = document.getElementById('slotGrid');
  if (!supplierId) { grid.innerHTML = ''; return; }

  const slots = await api('GET', `/api/member/suppliers/${supplierId}/slots`);
  if (!slots.length) {
    grid.innerHTML = '<p class="empty">This supplier hasn\'t made any slots available yet.</p>';
    return;
  }

  const requestId = pendingRequestsBySupplier[supplierId] || null;

  const byDay = new Map();
  for (const s of slots) {
    if (!byDay.has(s.day_id)) byDay.set(s.day_id, { label: s.day_label, date: s.day_date, slots: [] });
    byDay.get(s.day_id).slots.push(s);
  }
  const days = [...byDay.entries()]; // [ [day_id, {label, date, slots}], ... ]

  grid.innerHTML = '';

  // Tabs - only worth showing if there's more than one day.
  let activeDayId = days[0][0];
  if (days.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'day-tabs';
    for (const [dayId, { label, date }] of days) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'day-tab';
      tab.dataset.dayId = dayId;
      tab.textContent = `${label} - ${formatDayAbbr(date)}`;
      tabs.appendChild(tab);
    }
    grid.appendChild(tabs);
  }

  const panel = document.createElement('div');
  grid.appendChild(panel);

  function renderDay(dayId) {
    activeDayId = dayId;
    const { label, date, slots: daySlots } = byDay.get(dayId);

    grid.querySelectorAll('.day-tab').forEach(t => {
      t.classList.toggle('active', Number(t.dataset.dayId) === Number(dayId));
    });

    panel.innerHTML = '';
    const heading = document.createElement('h3');
    heading.className = 'day-heading';
    heading.textContent = `${label} - ${formatDayAbbr(date)} (${formatUKDate(date)})`;
    panel.appendChild(heading);

    const wrap = document.createElement('div');
    wrap.className = 'slot-grid';
    for (const s of daySlots) {
      const div = document.createElement('div');
      const mine = s.status === 'booked' && s.booked_by_member_id === currentMemberId;
      div.className = `slot ${mine ? 'mine' : s.status}`;
      div.innerHTML = `${s.start_time}<small>${mine ? 'your booking' : s.status}</small>`;
      if (s.status === 'available') {
        div.title = 'Tap to book this slot';
        div.addEventListener('click', () => bookSlot(s.id, requestId));
      } else {
        div.title = mine ? 'Your company\'s booked slot' : 'Not available';
      }
      wrap.appendChild(div);
    }
    panel.appendChild(wrap);
  }

  grid.querySelectorAll('.day-tab').forEach(tab => {
    tab.addEventListener('click', () => renderDay(tab.dataset.dayId));
  });

  renderDay(activeDayId);
}

async function bookSlot(slotId, requestId, confirmCancel) {
  try {
    await api('POST', '/api/member/bookings', {
      slot_id: slotId, request_id: requestId, confirm_cancel_booking_id: confirmCancel ? true : null
    });
    showToast('Slot booked');
    await Promise.all([loadRequests(), loadBookings()]);
    loadSlots(document.getElementById('supplierSelect').value);
  } catch (err) {
    if (err.body && err.body.conflict) {
      if (confirm(err.body.message)) {
        bookSlot(slotId, requestId, true);
      }
      return;
    }
    showToast(err.message);
  }
}

async function loadBookings() {
  const bookings = await api('GET', '/api/member/bookings');
  const tbody = document.querySelector('#bookingsTable tbody');
  tbody.innerHTML = '';
  document.getElementById('bookingsEmpty').style.display = bookings.length ? 'none' : 'block';

  for (const b of bookings) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${b.day_label} - ${formatDayAbbr(b.day_date)} (${formatUKDate(b.day_date)})</td><td>${b.start_time}–${b.end_time}</td>` +
      `<td>${b.supplier_name}</td><td><button class="danger small" data-cancel="${b.id}">Cancel</button></td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-cancel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Cancel this booking? The slot will immediately become available to others.')) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/member/bookings/${btn.dataset.cancel}/cancel`);
        showToast('Booking cancelled');
        await Promise.all([loadRequests(), loadBookings()]);
        loadSlots(document.getElementById('supplierSelect').value);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
      }
    });
  });
}

let currentMemberId = null;

document.getElementById('emailTimetableBtn').addEventListener('click', async () => {
  const input = document.getElementById('timetableEmail');
  const btn = document.getElementById('emailTimetableBtn');
  const email = input.value.trim();
  if (!email) {
    showToast('Enter an email address first');
    return;
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/member/bookings/email-timetable', { email });
    showToast(`Timetable sent to ${email}`);
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

(async function init() {
  await loadSuppliers();
  await loadRequests();
  await loadBookings();
  const { me } = await connectRealtime((msg) => {
    showToast(
      msg.type === 'request' ? `${msg.supplier_name} would like to meet you` :
      msg.type === 'booking' || msg.type === 'cancellation' ? 'A slot you were viewing just changed' :
      'Update received'
    );
    loadRequests();
    loadBookings();
    const sel = document.getElementById('supplierSelect').value;
    if (sel) loadSlots(sel);
  });
  currentMemberId = me.id;
  document.getElementById('whoami').textContent = me.name;
  document.getElementById('requestsHeading').textContent = `Meeting requests for ${me.name}`;
})();
