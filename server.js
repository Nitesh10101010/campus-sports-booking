const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'campus-sports-dev-secret';
const PORT = process.env.PORT || 3000;
const SLOT_TAKEN = 'This slot is no longer available';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const isPast = (date, start) => date < todayStr() || (date === todayStr() && start <= nowTime());
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(new Date(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const validTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const text = (v, field, required = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  return s;
};
const int = (v, field, min = 0) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${field} must be a whole number >= ${min}`);
  return n;
};

/* ---------- auth ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(payload.id);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
const requireRole = role => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: `${role} access required` });

app.post('/api/auth/login', wrap((req, res) => {
  const email = text(req.body.email, 'Email').toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) throw new HttpError(401, 'Invalid email or password');
  const token = jwt.sign({ id: row.id, role: row.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: row.id, name: row.name, email: row.email, role: row.role } });
}));
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

/* ---------- equipment release for finished bookings ---------- */
const restoreEquipment = db.prepare(`
  UPDATE equipment SET stock = stock + (
    SELECT quantity FROM booking_equipment WHERE booking_id = @id AND equipment_id = equipment.id)
  WHERE id IN (SELECT equipment_id FROM booking_equipment WHERE booking_id = @id)`);

const releaseFinished = db.transaction(() => {
  const rows = db.prepare(`
    SELECT b.id FROM bookings b JOIN time_slots t ON t.id = b.time_slot_id
    WHERE b.status='active' AND b.equipment_released=0 AND (b.booking_date || ' ' || t.end_time) <= ?`)
    .all(`${todayStr()} ${nowTime()}`);
  for (const r of rows) {
    restoreEquipment.run({ id: r.id });
    db.prepare('UPDATE bookings SET equipment_released=1 WHERE id=?').run(r.id);
  }
});
releaseFinished.immediate();
setInterval(() => { try { releaseFinished.immediate(); } catch (e) { console.error(e.message); } }, 60000).unref();

/* ---------- facilities, availability, equipment (any logged-in user) ---------- */
app.get('/api/facilities', auth, wrap((req, res) => {
  const admin = req.user.role === 'admin';
  const facilities = db.prepare(`SELECT * FROM facilities ${admin ? '' : 'WHERE active=1'} ORDER BY name`).all();
  const slotQ = db.prepare(`SELECT * FROM time_slots WHERE facility_id=? ${admin ? '' : 'AND active=1'} ORDER BY start_time`);
  res.json({ facilities: facilities.map(f => ({ ...f, slots: slotQ.all(f.id) })) });
}));

app.get('/api/availability', auth, wrap((req, res) => {
  const fid = int(req.query.facility_id, 'facility_id', 1);
  const date = req.query.date;
  if (!validDate(date)) throw new HttpError(400, 'Invalid date (use YYYY-MM-DD)');
  const block = db.prepare('SELECT reason FROM maintenance_blocks WHERE facility_id=? AND ? BETWEEN start_date AND end_date').get(fid, date);
  const booked = new Set(db.prepare("SELECT time_slot_id FROM bookings WHERE facility_id=? AND booking_date=? AND status='active'")
    .all(fid, date).map(r => r.time_slot_id));
  const slots = db.prepare('SELECT * FROM time_slots WHERE facility_id=? AND active=1 ORDER BY start_time').all(fid);
  res.json({
    blocked: block ? block.reason : null,
    slots: slots.map(s => ({
      ...s,
      status: block ? 'blocked' : isPast(date, s.start_time) ? 'past' : booked.has(s.id) ? 'booked' : 'available'
    }))
  });
}));

app.get('/api/equipment', auth, (req, res) =>
  res.json({ equipment: db.prepare('SELECT * FROM equipment ORDER BY name').all() }));

/* ---------- bookings ---------- */
// BEGIN IMMEDIATE (via .immediate()) takes the write lock before any read, so the
// availability check, the insert and the stock deduction are one atomic unit.
const createBooking = db.transaction((userId, b) => {
  const fac = db.prepare('SELECT id FROM facilities WHERE id=? AND active=1').get(b.facility_id);
  if (!fac) throw new HttpError(404, 'Facility not found');
  const slot = db.prepare('SELECT * FROM time_slots WHERE id=? AND facility_id=? AND active=1').get(b.time_slot_id, b.facility_id);
  if (!slot) throw new HttpError(404, 'Time slot not found');
  if (isPast(b.booking_date, slot.start_time)) throw new HttpError(400, 'This time slot has already started or passed');
  if (db.prepare('SELECT 1 FROM maintenance_blocks WHERE facility_id=? AND ? BETWEEN start_date AND end_date').get(b.facility_id, b.booking_date))
    throw new HttpError(409, SLOT_TAKEN);
  if (db.prepare("SELECT 1 FROM bookings WHERE facility_id=? AND booking_date=? AND time_slot_id=? AND status='active'")
    .get(b.facility_id, b.booking_date, b.time_slot_id)) throw new HttpError(409, SLOT_TAKEN);

  const info = db.prepare('INSERT INTO bookings (user_id,facility_id,time_slot_id,booking_date) VALUES (?,?,?,?)')
    .run(userId, b.facility_id, b.time_slot_id, b.booking_date);
  const id = info.lastInsertRowid;
  for (const item of b.equipment) {
    if (!db.prepare('SELECT 1 FROM equipment WHERE id=?').get(item.equipment_id)) throw new HttpError(404, 'Equipment not found');
    // CHECK (stock >= 0) aborts the whole transaction if stock is insufficient
    db.prepare('UPDATE equipment SET stock = stock - ? WHERE id=?').run(item.quantity, item.equipment_id);
    db.prepare('INSERT INTO booking_equipment (booking_id,equipment_id,quantity) VALUES (?,?,?)').run(id, item.equipment_id, item.quantity);
  }
  return id;
});

app.post('/api/bookings', auth, requireRole('student'), (req, res, next) => {
  try {
    const facility_id = int(req.body.facility_id, 'facility_id', 1);
    const time_slot_id = int(req.body.time_slot_id, 'time_slot_id', 1);
    const booking_date = req.body.booking_date;
    if (!validDate(booking_date)) throw new HttpError(400, 'Invalid date (use YYYY-MM-DD)');
    const merged = new Map();
    for (const it of Array.isArray(req.body.equipment) ? req.body.equipment : []) {
      const eid = int(it.equipment_id, 'equipment_id', 1);
      const q = int(it.quantity, 'quantity', 0);
      if (q > 0) merged.set(eid, (merged.get(eid) || 0) + q);
    }
    const equipment = [...merged].map(([equipment_id, quantity]) => ({ equipment_id, quantity }));
    const id = createBooking.immediate(req.user.id, { facility_id, time_slot_id, booking_date, equipment });
    res.status(201).json({ message: 'Booking confirmed', booking_id: Number(id) });
  } catch (err) {
    const code = err.code || '';
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code.startsWith('SQLITE_BUSY') || code === 'SQLITE_LOCKED')
      return res.status(409).json({ error: SLOT_TAKEN });
    if (code === 'SQLITE_CONSTRAINT_CHECK')
      return res.status(409).json({ error: 'Requested equipment is no longer available in that quantity' });
    next(err);
  }
});

const BOOKING_SELECT = `
  SELECT b.id, b.booking_date, b.status, b.created_at, b.equipment_released,
         f.name AS facility, t.start_time, t.end_time, u.name AS user_name, u.email AS user_email,
         (SELECT group_concat(e.name || ' x' || be.quantity, ', ') FROM booking_equipment be
            JOIN equipment e ON e.id = be.equipment_id WHERE be.booking_id = b.id) AS equipment
  FROM bookings b
  JOIN facilities f ON f.id = b.facility_id
  JOIN time_slots t ON t.id = b.time_slot_id
  JOIN users u ON u.id = b.user_id`;
const decorate = rows => rows.map(r => ({
  ...r,
  can_cancel: r.status === 'active' && !isPast(r.booking_date, r.start_time)
}));

app.get('/api/bookings/mine', auth, requireRole('student'), (req, res) =>
  res.json({ bookings: decorate(db.prepare(`${BOOKING_SELECT} WHERE b.user_id=? ORDER BY b.booking_date DESC, t.start_time DESC`).all(req.user.id)) }));

const cancelBooking = db.transaction((id, user) => {
  const b = db.prepare(`SELECT b.*, t.start_time FROM bookings b JOIN time_slots t ON t.id=b.time_slot_id WHERE b.id=?`).get(id);
  if (!b || (user.role !== 'admin' && b.user_id !== user.id)) throw new HttpError(404, 'Booking not found');
  if (b.status !== 'active') throw new HttpError(409, 'Booking is already cancelled');
  if (user.role !== 'admin' && isPast(b.booking_date, b.start_time)) throw new HttpError(400, 'Bookings that have started cannot be cancelled');
  if (!b.equipment_released) restoreEquipment.run({ id });
  db.prepare("UPDATE bookings SET status='cancelled', equipment_released=1, cancelled_at=datetime('now') WHERE id=?").run(id);
});
app.post('/api/bookings/:id/cancel', auth, wrap((req, res) => {
  cancelBooking.immediate(int(req.params.id, 'id', 1), req.user);
  res.json({ message: 'Booking cancelled and equipment restored' });
}));

/* ---------- admin ---------- */
const admin = [auth, requireRole('admin')];

app.get('/api/admin/bookings', ...admin, (req, res) =>
  res.json({ bookings: decorate(db.prepare(`${BOOKING_SELECT} ORDER BY b.booking_date DESC, t.start_time DESC LIMIT 500`).all()) }));

app.post('/api/admin/facilities', ...admin, wrap((req, res) => {
  const id = db.prepare('INSERT INTO facilities (name,description,location) VALUES (?,?,?)')
    .run(text(req.body.name, 'Name'), text(req.body.description, 'Description', false), text(req.body.location, 'Location', false)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
}));
app.put('/api/admin/facilities/:id', ...admin, wrap((req, res) => {
  const r = db.prepare('UPDATE facilities SET name=?, description=?, location=?, active=? WHERE id=?')
    .run(text(req.body.name, 'Name'), text(req.body.description, 'Description', false), text(req.body.location, 'Location', false),
      req.body.active ? 1 : 0, int(req.params.id, 'id', 1));
  if (!r.changes) throw new HttpError(404, 'Facility not found');
  res.json({ message: 'Facility saved' });
}));

function slotTimes(body) {
  if (!validTime(body.start_time) || !validTime(body.end_time)) throw new HttpError(400, 'Times must be HH:MM');
  if (body.start_time >= body.end_time) throw new HttpError(400, 'End time must be after start time');
  return [body.start_time, body.end_time];
}
app.post('/api/admin/facilities/:id/slots', ...admin, wrap((req, res) => {
  const fid = int(req.params.id, 'id', 1);
  if (!db.prepare('SELECT 1 FROM facilities WHERE id=?').get(fid)) throw new HttpError(404, 'Facility not found');
  const [s, e] = slotTimes(req.body);
  const id = db.prepare('INSERT INTO time_slots (facility_id,start_time,end_time) VALUES (?,?,?)').run(fid, s, e).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
}));
app.put('/api/admin/slots/:id', ...admin, wrap((req, res) => {
  const [s, e] = slotTimes(req.body);
  const r = db.prepare('UPDATE time_slots SET start_time=?, end_time=?, active=? WHERE id=?')
    .run(s, e, req.body.active ? 1 : 0, int(req.params.id, 'id', 1));
  if (!r.changes) throw new HttpError(404, 'Slot not found');
  res.json({ message: 'Slot saved' });
}));

app.post('/api/admin/equipment', ...admin, wrap((req, res) => {
  const total = int(req.body.total, 'Total stock', 0);
  const id = db.prepare('INSERT INTO equipment (name,total,stock) VALUES (?,?,?)').run(text(req.body.name, 'Name'), total, total).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
}));
const updateEquipment = db.transaction((id, name, total) => {
  const e = db.prepare('SELECT * FROM equipment WHERE id=?').get(id);
  if (!e) throw new HttpError(404, 'Equipment not found');
  // stock moves by the same delta as total; CHECK (stock >= 0) blocks cutting below what is reserved
  db.prepare('UPDATE equipment SET name=?, total=?, stock=stock+? WHERE id=?').run(name, total, total - e.total, id);
});
app.put('/api/admin/equipment/:id', ...admin, (req, res, next) => {
  try {
    updateEquipment.immediate(int(req.params.id, 'id', 1), text(req.body.name, 'Name'), int(req.body.total, 'Total stock', 0));
    res.json({ message: 'Equipment saved' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_CHECK') return res.status(409).json({ error: 'Total cannot be lower than the quantity currently reserved' });
    next(err);
  }
});

app.get('/api/admin/blocks', ...admin, (req, res) =>
  res.json({ blocks: db.prepare(`SELECT m.*, f.name AS facility FROM maintenance_blocks m JOIN facilities f ON f.id=m.facility_id ORDER BY m.start_date DESC`).all() }));
app.post('/api/admin/blocks', ...admin, wrap((req, res) => {
  const fid = int(req.body.facility_id, 'Facility', 1);
  const { start_date, end_date } = req.body;
  if (!validDate(start_date) || !validDate(end_date)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  if (start_date > end_date) throw new HttpError(400, 'End date must not be before start date');
  if (!db.prepare('SELECT 1 FROM facilities WHERE id=?').get(fid)) throw new HttpError(404, 'Facility not found');
  const id = db.prepare('INSERT INTO maintenance_blocks (facility_id,start_date,end_date,reason) VALUES (?,?,?,?)')
    .run(fid, start_date, end_date, text(req.body.reason, 'Reason', false) || 'Maintenance').lastInsertRowid;
  const affected = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE facility_id=? AND status='active' AND booking_date BETWEEN ? AND ?")
    .get(fid, start_date, end_date).c;
  res.status(201).json({ id: Number(id), existing_bookings_in_range: affected });
}));
app.delete('/api/admin/blocks/:id', ...admin, wrap((req, res) => {
  db.prepare('DELETE FROM maintenance_blocks WHERE id=?').run(int(req.params.id, 'id', 1));
  res.json({ message: 'Block removed' });
}));

/* ---------- errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON body' });
  const code = err.code || '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That name or time range already exists' });
  if (code.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Operation violates a data constraint' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Campus Sports Booking running on http://localhost:${PORT}`));
