let allMembers = [];
let memberSort = { key: 'surname', dir: 1 };

function surnameOf(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

function sortMembers(members) {
  const { key, dir } = memberSort;
  return [...members].sort((a, b) => {
    let av, bv;
    if (key === 'surname') { av = surnameOf(a.name); bv = surnameOf(b.name); }
    else if (key === 'company') { av = a.company || ''; bv = b.company || ''; }
    else { av = a.window_start || a.booked_start_time || ''; bv = b.window_start || b.booked_start_time || ''; }
    return av.localeCompare(bv) * dir;
  });
}

function renderMembers() {
  const members = sortMembers(allMembers);
  const tbody = document.querySelector('#membersTable tbody');
  tbody.innerHTML = '';
  document.getElementById('membersEmpty').style.display = members.length ? 'none' : 'block';

  for (const m of members) {
    const tr = document.createElement('tr');
    const attending = m.day_label ? `${m.day_label} (${m.window_start || '—'}–${m.window_end || '—'})` : '—';
    let actionHtml;
    if (m.request_status === 'pending') actionHtml = '<span class="pill pending">Requested</span>';
    else if (m.request_status === 'booked') {
      const time = m.booked_start_time ? ` ${m.booked_start_time}-${m.booked_end_time}` : '';
      actionHtml = `<span class="pill booked">Booked${time}</span>`;
    }
    else if (m.request_status === 'cancelled') actionHtml = '<button class="secondary small" data-req="' + m.id + '">Request again</button>';
    else actionHtml = '<button class="primary small" data-req="' + m.id + '">Request meeting</button>';

    tr.innerHTML = `<td>${m.name}</td><td>${m.company || ''}</td><td>${attending}</td><td>${actionHtml}</td>`;
    tbody.appendChild(tr);
  }

  document.querySelectorAll('#membersTable th.sortable').forEach(th => {
    th.classList.toggle('sort-active', th.dataset.sort === memberSort.key);
  });

  tbody.querySelectorAll('button[data-req]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', '/api/supplier/requests', { member_id: Number(btn.dataset.req) });
        showToast('Meeting request sent');
        loadMembers();
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
      }
    });
  });
}

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
    heading.textContent = `${day} — ${byDay[day][0].day_date}`;
    container.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    for (const s of byDay[day]) {
      const div = document.createElement('div');
      div.className = `slot ${s.status}`;
      div.innerHTML = `${s.start_time}<small>${s.status === 'booked' ? s.member_name : s.status}</small>`;
      if (s.status === 'available') {
        div.title = 'Tap to block this slot';
        div.addEventListener('click', () => toggleSlot(s.id, 'block'));
      } else if (s.status === 'blocked') {
        div.title = 'Tap to release this slot';
        div.addEventListener('click', () => toggleSlot(s.id, 'unblock'));
      } else {
        div.title = `Booked by ${s.member_name}`;
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
      'Schedule updated'
    );
    loadSchedule();
    loadMembers();
  });
  document.getElementById('whoami').textContent = me.name;
})();
