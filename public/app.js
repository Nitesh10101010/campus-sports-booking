/* Campus Sports Booking - vanilla JS single-page UI */
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const state = {
  token: localStorage.getItem('token'), user: null, tab: null,
  facilities: [], equipment: [], bookings: [], blocks: [],
  book: { facilityId: null, date: todayStr(), slotId: null, avail: null, eq: {} }
};

/* ---------- api + toast ---------- */
async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token && !url.startsWith('/auth/login')) logout();
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `px-4 py-2 rounded shadow text-sm text-white ${type === 'err' ? 'bg-red-600' : 'bg-teal-700'}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ---------- shared view pieces ---------- */
const inputCls = 'border border-slate-300 rounded px-3 py-2 text-sm w-full bg-white';
const btnCls = 'bg-teal-700 hover:bg-teal-800 text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed';
const btn2Cls = 'border border-slate-300 hover:bg-slate-100 rounded px-3 py-1.5 text-sm';
const card = (inner, extra = '') => `<section class="bg-white rounded-lg border border-slate-200 p-5 ${extra}">${inner}</section>`;
const badge = (txt, color) => `<span class="inline-block text-xs px-2 py-0.5 rounded-full ${color}">${esc(txt)}</span>`;
const statusBadge = b => b.status === 'cancelled' ? badge('Cancelled', 'bg-red-100 text-red-700')
  : b.can_cancel ? badge('Upcoming', 'bg-teal-100 text-teal-800') : badge('Completed', 'bg-slate-200 text-slate-700');

function shell(tabs, content) {
  return `
  <header class="bg-teal-800 text-white">
    <div class="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-lg font-semibold">Campus Sports Booking</h1>
      <div class="flex items-center gap-3 text-sm">
        <span>${esc(state.user.name)} (${esc(state.user.role)})</span>
        <button data-act="logout" class="bg-teal-900 hover:bg-black/40 rounded px-3 py-1">Log out</button>
      </div>
    </div>
    <nav class="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
      ${tabs.map(([id, label]) => `<button data-act="tab" data-tab="${id}" class="px-4 py-2 text-sm rounded-t ${state.tab === id ? 'bg-slate-50 text-teal-900 font-medium' : 'text-teal-100 hover:bg-teal-700'}">${label}</button>`).join('')}
    </nav>
  </header>
  <main class="max-w-6xl mx-auto px-4 py-6 space-y-6">${content}</main>`;
}

/* ---------- login ---------- */
function renderLogin() {
  const demo = [['Student 1', 'student1@campus.edu', 'pass123'], ['Student 2', 'student2@campus.edu', 'pass123'], ['Admin', 'admin@campus.edu', 'admin123']];
  $app.innerHTML = `
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-md space-y-4">
      <div><h1 class="text-2xl font-semibold text-teal-900">Campus Sports Booking</h1>
        <p class="text-slate-600 text-sm mt-1">Book courts and grounds, and reserve the equipment you need.</p></div>
      ${card(`
        <form data-form="login" class="space-y-3">
          <label class="block text-sm">Email<input name="email" type="email" required class="${inputCls} mt-1" autocomplete="username"></label>
          <label class="block text-sm">Password<input name="password" type="password" required class="${inputCls} mt-1" autocomplete="current-password"></label>
          <button class="${btnCls} w-full">Log in</button>
        </form>`)}
      ${card(`
        <h2 class="text-sm font-medium mb-2">Demo accounts</h2>
        <div class="space-y-2">
          ${demo.map(([n, e, p]) => `
            <button data-act="demo" data-email="${e}" data-pw="${p}" class="w-full text-left border border-slate-200 hover:bg-slate-50 rounded px-3 py-2 text-sm">
              <span class="font-medium">${n}</span><br><span class="text-slate-500">${e} / ${p}</span>
            </button>`).join('')}
        </div>`)}
    </div>
  </div>`;
}

/* ---------- student ---------- */
function renderStudent() {
  const content = state.tab === 'mine' ? studentMine() : studentBook();
  $app.innerHTML = shell([['book', 'Book a facility'], ['mine', 'My bookings']], content);
}

function studentBook() {
  const b = state.book;
  const fac = state.facilities.find(f => f.id === b.facilityId);
  const slotStyle = {
    available: 'border-teal-600 text-teal-900 hover:bg-teal-50',
    booked: 'bg-slate-100 text-slate-400 line-through cursor-not-allowed',
    past: 'bg-slate-100 text-slate-400 cursor-not-allowed',
    blocked: 'bg-amber-50 text-amber-700 cursor-not-allowed'
  };
  const slots = !b.avail ? '' : b.avail.blocked
    ? `<p class="text-sm text-amber-700">Closed on this date: ${esc(b.avail.blocked)}.</p>`
    : b.avail.slots.length === 0 ? '<p class="text-sm text-slate-500">This facility has no time slots yet.</p>'
    : `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        ${b.avail.slots.map(s => `
          <button data-act="slot" data-id="${s.id}" ${s.status !== 'available' ? 'disabled' : ''}
            class="border rounded px-2 py-2 text-sm ${b.slotId === s.id ? 'bg-teal-700 text-white border-teal-700' : slotStyle[s.status]}">
            ${esc(s.start_time)}–${esc(s.end_time)}<br><span class="text-xs">${s.status === 'available' ? (b.slotId === s.id ? 'Selected' : 'Open') : s.status === 'booked' ? 'Booked' : s.status === 'past' ? 'Passed' : 'Closed'}</span>
          </button>`).join('')}
      </div>`;
  return `
  <div class="grid lg:grid-cols-3 gap-6">
    <div class="lg:col-span-2 space-y-6">
      ${card(`
        <h2 class="font-semibold mb-3">1. Choose a facility</h2>
        ${state.facilities.length === 0 ? '<p class="text-sm text-slate-500">No facilities are open for booking.</p>' : ''}
        <div class="grid sm:grid-cols-2 gap-3">
          ${state.facilities.map(f => `
            <button data-act="facility" data-id="${f.id}" class="text-left border rounded p-3 ${f.id === b.facilityId ? 'border-teal-700 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'}">
              <span class="font-medium">${esc(f.name)}</span><br>
              <span class="text-xs text-slate-500">${esc(f.location)}</span>
              <p class="text-sm text-slate-600 mt-1">${esc(f.description)}</p>
            </button>`).join('')}
        </div>`)}
      ${card(`
        <h2 class="font-semibold mb-3">2. Pick a date and time slot${fac ? ` for ${esc(fac.name)}` : ''}</h2>
        <label class="block text-sm mb-4">Date
          <input type="date" data-date min="${todayStr()}" value="${b.date}" class="${inputCls} mt-1 max-w-xs"></label>
        ${slots}`)}
    </div>
    <div class="space-y-6">
      ${card(`
        <h2 class="font-semibold mb-3">3. Add equipment (optional)</h2>
        <div class="space-y-2">
          ${state.equipment.map(e => `
            <div class="flex items-center justify-between gap-2 text-sm">
              <div><span class="font-medium">${esc(e.name)}</span><br><span class="text-xs ${e.stock === 0 ? 'text-red-600' : 'text-slate-500'}">${e.stock} available</span></div>
              <input type="number" data-eq="${e.id}" min="0" max="${e.stock}" value="${b.eq[e.id] || 0}" ${e.stock === 0 ? 'disabled' : ''} class="border border-slate-300 rounded px-2 py-1 w-20 text-sm">
            </div>`).join('') || '<p class="text-sm text-slate-500">No equipment listed.</p>'}
        </div>`)}
      ${card(`
        <h2 class="font-semibold mb-3">Confirm</h2>
        <p class="text-sm text-slate-600 mb-3">${b.slotId && fac ? `${esc(fac.name)} on ${esc(b.date)}` : 'Select a facility, date and open time slot.'}</p>
        <button data-act="book" class="${btnCls} w-full" ${b.slotId ? '' : 'disabled'}>Confirm booking</button>`)}
    </div>
  </div>`;
}

function bookingTable(rows, { showUser = false, empty }) {
  if (!rows.length) return `<p class="text-sm text-slate-500">${empty}</p>`;
  return `<div class="overflow-x-auto"><table class="w-full text-sm">
    <thead><tr class="text-left text-slate-500 border-b">
      ${showUser ? '<th class="py-2 pr-3">Student</th>' : ''}<th class="py-2 pr-3">Facility</th><th class="pr-3">Date</th><th class="pr-3">Time</th><th class="pr-3">Equipment</th><th class="pr-3">Status</th><th></th>
    </tr></thead><tbody>
    ${rows.map(r => `<tr class="border-b last:border-0 align-top">
      ${showUser ? `<td class="py-2 pr-3">${esc(r.user_name)}<br><span class="text-xs text-slate-500">${esc(r.user_email)}</span></td>` : ''}
      <td class="py-2 pr-3">${esc(r.facility)}</td><td class="pr-3 whitespace-nowrap">${esc(r.booking_date)}</td>
      <td class="pr-3 whitespace-nowrap">${esc(r.start_time)}–${esc(r.end_time)}</td><td class="pr-3">${esc(r.equipment || '-')}</td>
      <td class="pr-3">${statusBadge(r)}</td>
      <td class="text-right">${(showUser ? r.status === 'active' : r.can_cancel) ? `<button data-act="cancel" data-id="${r.id}" class="${btn2Cls} text-red-700">Cancel</button>` : ''}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

function studentMine() {
  const up = state.bookings.filter(b => b.can_cancel);
  const past = state.bookings.filter(b => !b.can_cancel);
  return card(`<h2 class="font-semibold mb-3">Upcoming bookings</h2>${bookingTable(up, { empty: 'No upcoming bookings. Book a facility to get started.' })}`) +
    card(`<h2 class="font-semibold mb-3">Past and cancelled bookings</h2>${bookingTable(past, { empty: 'Nothing here yet.' })}`);
}

async function loadBook() {
  const [f, e] = await Promise.all([api('/facilities'), api('/equipment')]);
  state.facilities = f.facilities;
  state.equipment = e.equipment;
  if (!state.facilities.some(x => x.id === state.book.facilityId)) state.book.facilityId = state.facilities[0]?.id || null;
  await loadAvail();
}
async function loadAvail() {
  const b = state.book;
  b.slotId = null;
  b.avail = b.facilityId && b.date ? await api(`/availability?facility_id=${b.facilityId}&date=${b.date}`) : null;
}

/* ---------- admin ---------- */
function renderAdmin() {
  const views = { bookings: adminBookings, facilities: adminFacilities, equipment: adminEquipment, blocks: adminBlocks };
  $app.innerHTML = shell([['bookings', 'All bookings'], ['facilities', 'Facilities & slots'], ['equipment', 'Equipment'], ['blocks', 'Maintenance']], views[state.tab]());
}

const adminBookings = () => card(`<h2 class="font-semibold mb-3">All bookings</h2>${bookingTable(state.bookings, { showUser: true, empty: 'No bookings yet.' })}`);

function adminFacilities() {
  const addFac = card(`
    <h2 class="font-semibold mb-3">Add facility</h2>
    <form data-form="addFacility" class="grid sm:grid-cols-4 gap-2">
      <input name="name" required placeholder="Name" class="${inputCls}">
      <input name="location" placeholder="Location" class="${inputCls}">
      <input name="description" placeholder="Description" class="${inputCls}">
      <button class="${btnCls}">Add facility</button>
    </form>`);
  return addFac + state.facilities.map(f => card(`
    <form data-form="saveFacility" data-id="${f.id}" class="grid sm:grid-cols-5 gap-2 items-center">
      <input name="name" required value="${esc(f.name)}" class="${inputCls}">
      <input name="location" value="${esc(f.location)}" class="${inputCls}">
      <input name="description" value="${esc(f.description)}" class="${inputCls}">
      <label class="text-sm flex items-center gap-2"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Open for booking</label>
      <button class="${btnCls}">Save facility</button>
    </form>
    <h3 class="text-sm font-medium mt-4 mb-2">Time slots</h3>
    <div class="grid md:grid-cols-2 gap-2">
      ${f.slots.map(s => `
        <form data-form="saveSlot" data-id="${s.id}" class="flex items-center gap-2 text-sm">
          <input type="time" name="start_time" value="${esc(s.start_time)}" required class="border border-slate-300 rounded px-2 py-1">
          <span>to</span>
          <input type="time" name="end_time" value="${esc(s.end_time)}" required class="border border-slate-300 rounded px-2 py-1">
          <label class="flex items-center gap-1"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Active</label>
          <button class="${btn2Cls}">Save</button>
        </form>`).join('') || '<p class="text-sm text-slate-500">No slots yet.</p>'}
    </div>
    <form data-form="addSlot" data-id="${f.id}" class="flex flex-wrap items-center gap-2 text-sm mt-3">
      <span class="font-medium">New slot</span>
      <input type="time" name="start_time" required class="border border-slate-300 rounded px-2 py-1">
      <span>to</span>
      <input type="time" name="end_time" required class="border border-slate-300 rounded px-2 py-1">
      <button class="${btn2Cls}">Add slot</button>
    </form>`, 'space-y-1')).join('');
}

function adminEquipment() {
  return card(`
    <h2 class="font-semibold mb-3">Add equipment</h2>
    <form data-form="addEquip" class="grid sm:grid-cols-3 gap-2">
      <input name="name" required placeholder="Name" class="${inputCls}">
      <input name="total" type="number" min="0" required placeholder="Total stock" class="${inputCls}">
      <button class="${btnCls}">Add equipment</button>
    </form>`) + card(`
    <h2 class="font-semibold mb-3">Inventory</h2>
    <div class="space-y-2">
      ${state.equipment.map(e => `
        <form data-form="saveEquip" data-id="${e.id}" class="grid sm:grid-cols-5 gap-2 items-center">
          <input name="name" required value="${esc(e.name)}" class="${inputCls} sm:col-span-2">
          <label class="text-sm flex items-center gap-2">Total <input name="total" type="number" min="0" required value="${e.total}" class="border border-slate-300 rounded px-2 py-1 w-20"></label>
          <span class="text-sm text-slate-600">${e.stock} available, ${e.total - e.stock} reserved</span>
          <button class="${btn2Cls}">Save</button>
        </form>`).join('')}
    </div>`);
}

function adminBlocks() {
  return card(`
    <h2 class="font-semibold mb-3">Block a maintenance period</h2>
    <form data-form="addBlock" class="grid sm:grid-cols-5 gap-2">
      <select name="facility_id" required class="${inputCls}">${state.facilities.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
      <input type="date" name="start_date" min="${todayStr()}" required class="${inputCls}">
      <input type="date" name="end_date" min="${todayStr()}" required class="${inputCls}">
      <input name="reason" placeholder="Reason (e.g. Floor resurfacing)" class="${inputCls}">
      <button class="${btnCls}">Block dates</button>
    </form>`) + card(`
    <h2 class="font-semibold mb-3">Current blocks</h2>
    ${state.blocks.length === 0 ? '<p class="text-sm text-slate-500">No maintenance periods are blocked.</p>' : `
    <div class="space-y-2">
      ${state.blocks.map(m => `
        <div class="flex items-center justify-between border border-slate-200 rounded px-3 py-2 text-sm">
          <span><span class="font-medium">${esc(m.facility)}</span>, ${esc(m.start_date)} to ${esc(m.end_date)} (${esc(m.reason)})</span>
          <button data-act="delBlock" data-id="${m.id}" class="${btn2Cls}">Remove</button>
        </div>`).join('')}
    </div>`}`);
}

/* ---------- routing / data loading ---------- */
async function go(tab) {
  state.tab = tab;
  try {
    if (state.user.role === 'student') {
      if (tab === 'book') await loadBook();
      else state.bookings = (await api('/bookings/mine')).bookings;
    } else if (tab === 'bookings') state.bookings = (await api('/admin/bookings')).bookings;
    else if (tab === 'facilities') state.facilities = (await api('/facilities')).facilities;
    else if (tab === 'equipment') state.equipment = (await api('/equipment')).equipment;
    else if (tab === 'blocks') {
      const [b, f] = await Promise.all([api('/admin/blocks'), api('/facilities')]);
      state.blocks = b.blocks;
      state.facilities = f.facilities;
    }
  } catch (e) { toast(e.message, 'err'); }
  render();
}
function render() {
  if (!state.user) return renderLogin();
  state.user.role === 'admin' ? renderAdmin() : renderStudent();
}
function logout() {
  localStorage.removeItem('token');
  state.token = null; state.user = null;
  render();
}
async function doLogin(email, password) {
  const r = await api('/auth/login', 'POST', { email, password });
  state.token = r.token;
  state.user = r.user;
  localStorage.setItem('token', r.token);
  await go(r.user.role === 'admin' ? 'bookings' : 'book');
}

/* ---------- events ---------- */
const forms = {
  login: d => doLogin(d.email, d.password),
  addFacility: async d => { await api('/admin/facilities', 'POST', d); toast('Facility added'); },
  saveFacility: async (d, id) => { await api(`/admin/facilities/${id}`, 'PUT', { ...d, active: d.active === 'on' }); toast('Facility saved'); },
  addSlot: async (d, id) => { await api(`/admin/facilities/${id}/slots`, 'POST', d); toast('Slot added'); },
  saveSlot: async (d, id) => { await api(`/admin/slots/${id}`, 'PUT', { ...d, active: d.active === 'on' }); toast('Slot saved'); },
  addEquip: async d => { await api('/admin/equipment', 'POST', d); toast('Equipment added'); },
  saveEquip: async (d, id) => { await api(`/admin/equipment/${id}`, 'PUT', d); toast('Equipment saved'); },
  addBlock: async d => {
    const r = await api('/admin/blocks', 'POST', d);
    toast(r.existing_bookings_in_range ? `Dates blocked. ${r.existing_bookings_in_range} existing booking(s) in range were kept; cancel them under All bookings.` : 'Dates blocked');
  }
};

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const name = f.dataset.form;
  try {
    await forms[name](Object.fromEntries(new FormData(f)), f.dataset.id);
    if (name !== 'login') await go(state.tab);
  } catch (err) { toast(err.message, 'err'); }
});

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const { act, id, tab } = t.dataset;
  const b = state.book;
  try {
    if (act === 'logout') logout();
    else if (act === 'tab') await go(tab);
    else if (act === 'demo') await doLogin(t.dataset.email, t.dataset.pw);
    else if (act === 'facility') { b.facilityId = +id; await loadAvail(); render(); }
    else if (act === 'slot') { b.slotId = +id; render(); }
    else if (act === 'book') {
      const equipment = Object.entries(b.eq).filter(([, q]) => q > 0).map(([k, q]) => ({ equipment_id: +k, quantity: q }));
      try {
        await api('/bookings', 'POST', { facility_id: b.facilityId, time_slot_id: b.slotId, booking_date: b.date, equipment });
        toast('Booking confirmed. Find it under My bookings.');
        b.eq = {};
      } catch (err) {
        toast(err.message, 'err');
        if (err.status !== 409 && err.status !== 400) return;
      }
      await loadBook();
      render();
    } else if (act === 'cancel') {
      if (!confirm('Cancel this booking? Reserved equipment will be returned to stock.')) return;
      await api(`/bookings/${id}/cancel`, 'POST');
      toast('Booking cancelled');
      await go(state.tab);
    } else if (act === 'delBlock') {
      await api(`/admin/blocks/${id}`, 'DELETE');
      toast('Block removed');
      await go('blocks');
    }
  } catch (err) { toast(err.message, 'err'); }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('[data-date]')) {
    state.book.date = t.value;
    try { await loadAvail(); } catch (err) { toast(err.message, 'err'); }
    render();
  } else if (t.matches('[data-eq]')) {
    const max = +t.max || 0;
    const q = Math.max(0, Math.min(max, parseInt(t.value, 10) || 0));
    t.value = q;
    state.book.eq[t.dataset.eq] = q;
  }
});

(async function boot() {
  if (state.token) {
    try { state.user = (await api('/auth/me')).user; } catch { state.token = null; localStorage.removeItem('token'); }
  }
  if (state.user) await go(state.user.role === 'admin' ? 'bookings' : 'book');
  else render();
})();
