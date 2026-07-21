async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || 'Something went wrong');
    err.body = data;
    throw err;
  }
  return data;
}

function showToast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

/** Connects to Socket.io and joins this user's private room (and, for attendees,
 *  their company-wide room too, so colleagues' activity shows up live). Calls
 *  onUpdate(msg) on every event. */
async function connectRealtime(onUpdate) {
  const me = await api('GET', '/api/auth/me');
  const socket = io();
  socket.on('connect', () => {
    socket.emit('join', me.socketToken);
    if (me.companySocketToken) socket.emit('join', me.companySocketToken);
  });
  socket.on('update', onUpdate);
  return { socket, me };
}

async function logout() {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
}
