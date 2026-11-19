const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

// timeout = busy_timeout (ms): a writer waits for the lock instead of failing instantly
const db = new Database(path.join(__dirname, 'database.sqlite'), { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','admin'))
);
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS time_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (facility_id, start_time, end_time),
  CHECK (start_time < end_time)
);
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  total INTEGER NOT NULL CHECK (total >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  time_slot_id INTEGER NOT NULL REFERENCES time_slots(id),
  booking_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  equipment_released INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
-- Only ACTIVE bookings are unique per slot/date, so cancelled slots can be re-booked
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_booking
  ON bookings (facility_id, booking_date, time_slot_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS booking_equipment (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (booking_id, equipment_id)
);
CREATE TABLE IF NOT EXISTS maintenance_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Maintenance',
  CHECK (start_date <= end_date)
);
`);

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return;
  const tx = db.transaction(() => {
    const addUser = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
    addUser.run('Student One', 'student1@campus.edu', bcrypt.hashSync('pass123', 10), 'student');
    addUser.run('Student Two', 'student2@campus.edu', bcrypt.hashSync('pass123', 10), 'student');
    addUser.run('Sports Admin', 'admin@campus.edu', bcrypt.hashSync('admin123', 10), 'admin');

    const addFac = db.prepare('INSERT INTO facilities (name,description,location) VALUES (?,?,?)');
    const addSlot = db.prepare('INSERT INTO time_slots (facility_id,start_time,end_time) VALUES (?,?,?)');
    const facilities = [
      ['Basketball Court', 'Full-size indoor hardwood court with two hoops.', 'Sports Complex, Block A'],
      ['Football Ground', 'Natural turf ground with floodlights.', 'North Campus Field'],
      ['Tennis Court', 'Hard court, lit for evening play.', 'Sports Complex, Block B'],
      ['Badminton Hall', 'Four wooden-floor courts.', 'Sports Complex, Block A']
    ];
    for (const [n, d, l] of facilities) {
      const id = addFac.run(n, d, l).lastInsertRowid;
      for (let h = 8; h < 20; h++) {
        const p = x => String(x).padStart(2, '0') + ':00';
        addSlot.run(id, p(h), p(h + 1));
      }
    }

    const addEq = db.prepare('INSERT INTO equipment (name,total,stock) VALUES (?,?,?)');
    [['Basketball', 10], ['Football', 8], ['Tennis Racket', 12], ['Tennis Ball Can', 20], ['Badminton Racket', 16], ['Shuttlecock Tube', 15]]
      .forEach(([n, q]) => addEq.run(n, q, q));
  });
  tx();
}
seed();

module.exports = db;
