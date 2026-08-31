let allMembers = [];
let memberSort = { key: 'name', dir: 1 };
const MAX_REQUESTS = 40;
let newSelections = new Set(); // member ids ticked this session, not yet submitted

function sortMembers(members) {
  const { key, dir } = memberSort;
  return [...members].sort((a, b) => {
    let av, bv;
    if (key === 'name') { av = a.name; bv = b.name; }
    else if (key === 'date') { av = a.booked_date || '9999-99-99'; bv = b.booked_date || '9999-99-99'; }
    else { av = String(a.booking_count || 0); bv = String(b.booking_count || 0); }
    return av.localeCompare(bv) * dir;
  });
}

function formatUKDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

function activeCount() {
  return allMembers.filter(m => m.booking_count > 0 || m.request_status === 'pending').length;
}

function updateSelectionUI() {
  const btn = document.getElementById('requestSelectedBtn');
  const label = document.getElementById('selectionCount');
  btn.disabled = newSelections.size === 0;
  const spaceLeft = MAX_REQUESTS - activeCount();
  label.textContent = `${activeCount()} of ${MAX_REQUESTS} requested` +
    (newSelections.size ? ` · ${newSelections.size} new selected` : '') +
    ` · ${spaceLeft} space${spaceLeft === 1 ? '' : 's'} left`;
}

function renderMembers() {
  const members = sortMembers(allMembers);
  const tbody = document.querySelector('#membersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('membersEmpty').style.display = members.length ? 'none' : 'block';

  for (const m of members) {
    const tr = document.createElement('tr');
    const isBooked = m.booking_count > 0;
    const isPending = m.request_status === 'pending';
    const isLocked = isBooked || isPending; // already committed - can't untick
    const isTicked = isLocked || newSelections.has(m.id);

    const checkbox = `<input type="checkbox" data-member="${m.id}" ${isTicked ? 'checked' : ''} ${isLocked ? 'disabled' : ''}>`;

    let statusHtml;
    if (isBooked) {
      const extra = m.booking_count > 1 ? ` (+${m.booking_count - 1} more)` : '';
      statusHtml = `<span class="pill booked">Booked${extra}</span>`;
    } else if (isPending) {
      statusHtml = '<span class="pill pending">Requested</span>';
    } else if (newSelections.has(m.id)) {
      statusHtml = '<span class="pill pending">Selected</span>';
    } else if (m.request_status === 'declined') {
      statusHtml = '<span class="pill">Declined</span>';
    } else if (m.request_status === 'cancelled') {
      statusHtml = '<span class="pill">Cancelled</span>';
    } else {
      statusHtml = '';
    }

    const dateCell = m.booked_date ? formatUKDate(m.booked_date) : '';
    const timeCell = m.booked_start_time ? `${m.booked_start_time}\u2013${m.booked_end_time}` : '';

    tr.innerHTML = `<td>${checkbox}</td><td>${m.name}</td><td>${dateCell}</td><td>${timeCell}</td><td>${statusHtml}</td>`;
    tbody.appendChild(tr);
  }

  document.querySelectorAll('#membersTable th.sortable').forEach(th => {
    th.classList.toggle('sort-active', th.dataset.sort === memberSort.key);
  });

  tbody.querySelectorAll('input[type="checkbox"][data-member]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.member);
      if (cb.checked) {
        if (activeCount() + newSelections.size + 1 > MAX_REQUESTS) {
          cb.checked = false;
          showToast(`You're at the ${MAX_REQUESTS}-member limit - untick someone else first`);
          return;
        }
        newSelections.add(id);
      } else {
        newSelections.delete(id);
      }
      renderMembers();
    });
  });

  updateSelectionUI();
}

document.getElementById('requestSelectedBtn').addEventListener('click', async () => {
  const btn = document.getElementById('requestSelectedBtn');
  if (!newSelections.size) return;
  btn.disabled = true;
  try {
    const { requested } = await api('POST', '/api/supplier/requests/batch', { member_ids: [...newSelections] });
    showToast(`${requested} meeting request${requested === 1 ? '' : 's'} sent`);
    newSelections.clear();
    await loadMembers();
  } catch (err) {
    showToast(err.message);
    btn.disabled = false;
  }
});

async function loadMembers() {
  allMembers = await api('GET', '/api/supplier/members');
  renderMembers();
}

document.querySelectorAll('#membersTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    if (memberSort.key === th.dataset.sort) memberSort.dir *= -1;
    else memberSort = { key: th.dataset.sort, dir: 1 };
    renderMembers();
  });
});

async function loadSchedule() {
  const slots = await api('GET', '/api/supplier/schedule');
  const container = document.getElementById('schedule');
  container.innerHTML = '';

  const byDay = {};
  for (const s of slots) {
    byDay[s.day_label] = byDay[s.day_label] || [];
    byDay[s.day_label].push(s);
  }

  for (const day of Object.keys(byDay)) {
    const heading = document.createElement('div');
    heading.className = 'day-heading';
    heading.textContent = `${day} — ${formatUKDate(byDay[day][0].day_date)}`;
    container.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    for (const s of byDay[day]) {
      const div = document.createElement('div');
      div.className = `slot ${s.status}`;
      div.innerHTML = `${s.start_time}<small>${s.status === 'booked' ? (s.member_company || s.member_name) : s.status}</small>`;
      if (s.status === 'available') {
        div.title = 'Tap to block this slot';
        div.addEventListener('click', () => toggleSlot(s.id, 'block'));
      } else if (s.status === 'blocked') {
        div.title = 'Tap to release this slot';
        div.addEventListener('click', () => toggleSlot(s.id, 'unblock'));
      } else {
        div.title = `Booked by ${s.member_company || s.member_name}`;
      }
      grid.appendChild(div);
    }
    container.appendChild(grid);
  }
}

async function toggleSlot(slotId, action) {
  try {
    await api('POST', `/api/supplier/slots/${slotId}/${action}`);
    loadSchedule();
  } catch (err) {
    showToast(err.message);
  }
}

(async function init() {
  await loadMembers();
  await loadSchedule();
  const { me } = await connectRealtime((msg) => {
    showToast(
      msg.type === 'booking' ? `${msg.member_name} booked ${msg.start_time}` :
      msg.type === 'cancellation' ? `${msg.member_name} cancelled ${msg.start_time} — now free` :
      msg.type === 'decline' ? `${msg.member_name} declined your request — space freed up` :
      'Schedule updated'
    );
    loadSchedule();
    loadMembers();
  });
  document.getElementById('whoami').textContent = me.name;
})();
