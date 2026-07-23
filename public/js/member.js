function formatUKDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

let pendingRequestsBySupplier = {};

async function loadRequests() {
  const requests = await api('GET', '/api/member/requests');
  pendingRequestsBySupplier = {};
  for (const r of requests) if (r.status === 'pending') pendingRequestsBySupplier[r.supplier_id] = r.id;

  const tbody = document.querySelector('#requestsTable tbody');
  tbody.innerHTML = '';
  document.getElementById('requestsEmpty').style.display = requests.length ? 'none' : 'block';

  for (const r of requests) {
    const tr = document.createElement('tr');
    const action = r.status === 'pending'
      ? `<button class="primary small" data-view="${r.supplier_id}">View slots</button>`
      : '';
    const dateCell = r.booked_date ? formatUKDate(r.booked_date) : '';
    const timeCell = r.booked_start_time ? `${r.booked_start_time}\u2013${r.booked_end_time}` : '';
    tr.innerHTML = `<td>${r.supplier_name}</td><td>${dateCell}</td><td>${timeCell}</td>` +
      `<td><span class="pill ${r.status}">${r.status}</span></td><td>${action}</td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('supplierSelect').value = btn.dataset.view;
      loadSlots(btn.dataset.view);
      document.getElementById('supplierSelect').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

async function loadSuppliers() {
  const suppliers = await api('GET', '/api/member/suppliers');
  const select = document.getElementById('supplierSelect');
  select.innerHTML = '<option value="">Select a supplier…</option>' +
    suppliers.map(s => `<option value="${s.id}">${s.name}${s.company ? ' — ' + s.company : ''}</option>`).join('');
  select.addEventListener('change', () => loadSlots(select.value));
}

async function loadSlots(supplierId) {
  const grid = document.getElementById('slotGrid');
  if (!supplierId) { grid.innerHTML = ''; return; }

  const slots = await api('GET', `/api/member/suppliers/${supplierId}/slots`);
  if (!slots.length) {
    grid.innerHTML = '<p class="empty">This supplier hasn\'t made any slots available yet.</p>';
    return;
  }

  const requestId = pendingRequestsBySupplier[supplierId] || null;
  grid.innerHTML = '';

  const byDay = new Map();
  for (const s of slots) {
    if (!byDay.has(s.day_id)) byDay.set(s.day_id, { label: s.day_label, date: s.day_date, slots: [] });
    byDay.get(s.day_id).slots.push(s);
  }

  for (const { label, date, slots: daySlots } of byDay.values()) {
    const heading = document.createElement('h3');
    heading.className = 'day-heading';
    heading.textContent = `${label} (${formatUKDate(date)})`;
    grid.appendChild(heading);

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
    grid.appendChild(wrap);
  }
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
    tr.innerHTML = `<td>${b.day_label} (${formatUKDate(b.day_date)})</td><td>${b.start_time}–${b.end_time}</td>` +
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
})();
