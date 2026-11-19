// Usage: start the server (npm start), then run: node test_concurrency.js
// Fires two simultaneous bookings for the exact same facility/date/slot (each with 1 piece of
// equipment) and verifies: exactly one 201, exactly one 409, and stock deducted exactly once.
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function call(path, method = 'GET', token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function login(email, password) {
  const r = await call('/api/auth/login', 'POST', null, { email, password });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  const [t1, t2] = await Promise.all([login('student1@campus.edu', 'pass123'), login('student2@campus.edu', 'pass123')]);

  const { data: { facilities } } = await call('/api/facilities', 'GET', t1);
  const facility = facilities[0];
  const slot = facility.slots.find(s => s.active);
  const stockOf = async id => (await call('/api/equipment', 'GET', t1)).data.equipment.find(e => e.id === id);
  const item = (await call('/api/equipment', 'GET', t1)).data.equipment.find(e => e.stock >= 2);
  if (!slot || !item) throw new Error('Need at least one active slot and one equipment item with stock >= 2');

  // random future date so the test can be re-run without clashing with earlier runs
  const date = new Date();
  date.setDate(date.getDate() + 30 + Math.floor(Math.random() * 300));
  const payload = {
    facility_id: facility.id, time_slot_id: slot.id, booking_date: fmt(date),
    equipment: [{ equipment_id: item.id, quantity: 1 }]
  };

  const stockBefore = (await stockOf(item.id)).stock;
  console.log(`Target: ${facility.name} | ${payload.booking_date} | ${slot.start_time}-${slot.end_time} | ${item.name} stock before: ${stockBefore}`);
  console.log('Firing 2 simultaneous booking requests...\n');

  const results = await Promise.all([
    call('/api/bookings', 'POST', t1, payload),
    call('/api/bookings', 'POST', t2, payload)
  ]);
  results.forEach((r, i) => console.log(`student${i + 1} -> HTTP ${r.status}`, JSON.stringify(r.data)));

  const ok = results.filter(r => r.status === 201);
  const conflict = results.filter(r => r.status === 409);
  const stockAfter = (await stockOf(item.id)).stock;
  console.log(`\n${item.name} stock after: ${stockAfter}`);

  const checks = [
    ['exactly one request succeeded (201)', ok.length === 1],
    ['exactly one request was rejected (409)', conflict.length === 1],
    ['conflict message is "This slot is no longer available"', conflict[0] && conflict[0].data.error === 'This slot is no longer available'],
    ['equipment deducted exactly once (no partial deduction)', stockAfter === stockBefore - 1]
  ];

  // cleanup: cancel the winning booking and confirm stock is restored
  if (ok.length === 1) {
    const winnerToken = results[0].status === 201 ? t1 : t2;
    const c = await call(`/api/bookings/${ok[0].data.booking_id}/cancel`, 'POST', winnerToken);
    checks.push(['cancelling restores equipment stock', c.status === 200 && (await stockOf(item.id)).stock === stockBefore]);
  }

  console.log('');
  let pass = true;
  for (const [name, passed] of checks) { console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`); pass = pass && !!passed; }
  console.log(pass ? '\nAll checks passed.' : '\nSome checks failed.');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('Test error:', e.message); process.exit(1); });
