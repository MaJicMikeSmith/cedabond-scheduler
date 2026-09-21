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

/** Switches an admin-impersonated member/supplier session back to the
 *  original admin session. Only ever called from the "Return to Admin"
 *  button shown when me.impersonating is true. */
async function returnToAdmin() {
  const { redirect } = await api('POST', '/api/auth/return-to-admin');
  window.location.href = redirect;
}

/** Shows a small fixed "Return to Admin" button in the top bar when this
 *  session is an admin managing a member/supplier's account directly.
 *  Call this once `me` is available, on both the member and supplier portals. */
function showReturnToAdminIfNeeded(me) {
  if (!me.impersonating) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:1000; background:#7A1F1F; color:#fff; text-align:center; padding:8px; font-size:14px;';
  bar.innerHTML = `Managing as <strong>${me.name}</strong> on behalf of Admin. <button id="returnToAdminBtn" style="margin-left:12px; padding:4px 12px; border-radius:6px; border:none; cursor:pointer;">Return to Admin</button>`;
  document.body.prepend(bar);
  document.body.style.paddingTop = '40px';
  document.getElementById('returnToAdminBtn').addEventListener('click', returnToAdmin);
}

/** Shows a clear, persistent banner when this member's/supplier's account
 *  has been locked by admin - visible the moment they log in, before they
 *  try anything. The backend still refuses every write action regardless;
 *  this is just so it's obvious why, right away. */
function showLockedBannerIfNeeded(me) {
  if (!me.locked) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:1000; background:#B8860B; color:#fff; text-align:center; padding:8px; font-size:14px;';
  bar.textContent = 'No changes can currently be made on this account - please contact the organiser if you need something changed.';
  document.body.prepend(bar);
  document.body.style.paddingTop = document.body.style.paddingTop ? '80px' : '40px';
}
