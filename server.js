/**
 * Quantum Snippet — Express Backend (zero-compilation build)
 * Storage : data.json (flat file, no database needed)
 * Email   : Nodemailer via Gmail App Password
 * Deps    : express, cors, nodemailer, dotenv  (all pure JS, no build tools)
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ─── Flat-file JSON database ──────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'data.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { bookings: [], contacts: [], nextId: 1 }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DB_FILE)) writeDB({ bookings: [], contacts: [], nextId: 1 });

// ─── Email ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function sendEmail(to, subject, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[email skipped]', subject); return;
  }
  try {
    await transporter.sendMail({
      from: `"Quantum Snippet" <${process.env.EMAIL_USER}>`, to, subject, html
    });
    console.log('[email sent]', subject, '->', to);
  } catch (err) { console.error('[email error]', err.message); }
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token  = req.headers['x-admin-token'];
  const secret = process.env.ADMIN_SECRET || 'qs-admin-2025';
  if (!token || token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(windowMs = 60000, max = 5) {
  return (req, res, next) => {
    const key = req.ip, now = Date.now();
    const r   = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > r.resetAt) { r.count = 0; r.resetAt = now + windowMs; }
    r.count++; rateLimits.set(key, r);
    if (r.count > max) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    next();
  };
}

// ─── Public: get booked slots ─────────────────────────────────────────────────
app.get('/api/bookings/slots', (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required' });
  const db     = readDB();
  const booked = db.bookings
    .filter(b => b.date_key.startsWith(month + '-') && b.status !== 'cancelled')
    .map(b => ({ date_key: b.date_key, time_slot: b.time_slot }));
  res.json({ booked });
});

// ─── Public: create booking ───────────────────────────────────────────────────
app.post('/api/bookings', rateLimit(60000, 3), (req, res) => {
  const { name, email, dateKey, timeSlot } = req.body;
  if (!name || !email || !dateKey || !timeSlot)
    return res.status(400).json({ error: 'All fields are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address.' });

  const db = readDB();
  const taken = db.bookings.find(
    b => b.date_key === dateKey && b.time_slot === timeSlot && b.status !== 'cancelled'
  );
  if (taken) return res.status(409).json({ error: 'That slot is already booked. Please pick another time.' });

  const [year, month, day] = dateKey.split('-').map(Number);
  const display = new Date(year, month, day).toLocaleDateString('en-US', {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  }) + ' at ' + timeSlot;

  const booking = { id: db.nextId++, name, email, date_key: dateKey, time_slot: timeSlot, status: 'pending', created_at: new Date().toISOString() };
  db.bookings.push(booking);
  writeDB(db);

  sendEmail(email, 'Your consultation is booked — Quantum Snippet', `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <div style="background:#C9A84C;padding:28px 32px;"><h1 style="margin:0;color:#000;">Quantum Snippet</h1></div>
      <div style="padding:32px;">
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your free 30-minute consultation is confirmed.</p>
        <div style="background:#f8f6f1;border-left:3px solid #C9A84C;padding:18px 22px;margin:24px 0;">
          <strong>📅 ${display}</strong>
        </div>
        <p style="color:#555;font-size:14px;">We'll send a calendar invite and call details shortly.</p>
        <p style="color:#555;font-size:14px;">— The Quantum Snippet Team</p>
      </div>
    </div>`);

  sendEmail(process.env.OWNER_EMAIL || process.env.EMAIL_USER,
    `🗓 New Booking: ${name} — ${display}`,
    `<h2>New Booking #${booking.id}</h2><p><b>Name:</b> ${name}</p><p><b>Email:</b> ${email}</p><p><b>When:</b> ${display}</p>`);

  res.json({ ok: true, id: booking.id, display });
});

// ─── Public: submit contact form ──────────────────────────────────────────────
app.post('/api/contact', rateLimit(60000, 3), (req, res) => {
  const { name, email, business, service, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });

  const db = readDB();
  const contact = { id: db.nextId++, name, email, business: business||'', service: service||'', message: message||'', status: 'new', created_at: new Date().toISOString() };
  db.contacts.push(contact);
  writeDB(db);

  sendEmail(email, 'We got your message — Quantum Snippet', `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <div style="background:#C9A84C;padding:28px 32px;"><h1 style="margin:0;color:#000;">Quantum Snippet</h1></div>
      <div style="padding:32px;">
        <p>Hi <strong>${name}</strong>,</p>
        <p>Thanks for reaching out! We'll get back to you within <strong>24 hours</strong>.</p>
        <a href="https://quantumsnippet.xyz/#booking" style="display:inline-block;margin-top:16px;background:#C9A84C;color:#000;padding:14px 28px;border-radius:2px;font-weight:600;text-decoration:none;">Book a Free Call</a>
        <p style="margin-top:28px;color:#555;font-size:14px;">— The Quantum Snippet Team</p>
      </div>
    </div>`);

  sendEmail(process.env.OWNER_EMAIL || process.env.EMAIL_USER,
    `✉️ New Lead: ${name} — ${service || 'No service'}`,
    `<h2>New Contact #${contact.id}</h2><p><b>Name:</b> ${name}</p><p><b>Email:</b> ${email}</p><p><b>Business:</b> ${business||'—'}</p><p><b>Service:</b> ${service||'—'}</p><p><b>Message:</b> ${message||'—'}</p>`);

  res.json({ ok: true, id: contact.id });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const db = readDB();
  res.json({
    totalBookings:   db.bookings.length,
    pendingBookings: db.bookings.filter(b => b.status === 'pending').length,
    totalContacts:   db.contacts.length,
    newContacts:     db.contacts.filter(c => c.status === 'new').length,
    todayBookings:   db.bookings.filter(b => b.created_at.startsWith(new Date().toISOString().slice(0,10))).length,
  });
});

app.get('/api/admin/bookings', adminAuth, (req, res) => {
  res.json([...readDB().bookings].reverse());
});

app.get('/api/admin/contacts', adminAuth, (req, res) => {
  res.json([...readDB().contacts].reverse());
});

app.patch('/api/admin/bookings/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['pending','confirmed','cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = readDB(), b = db.bookings.find(x => x.id === parseInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  b.status = status; writeDB(db); res.json({ ok: true });
});

app.patch('/api/admin/contacts/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['new','read','replied','closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = readDB(), c = db.contacts.find(x => x.id === parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.status = status; writeDB(db); res.json({ ok: true });
});

app.delete('/api/admin/bookings/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.bookings = db.bookings.filter(b => b.id !== parseInt(req.params.id));
  writeDB(db); res.json({ ok: true });
});

app.delete('/api/admin/contacts/:id', adminAuth, (req, res) => {
  const db = readDB();
  db.contacts = db.contacts.filter(c => c.id !== parseInt(req.params.id));
  writeDB(db); res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Quantum Snippet server running on http://localhost:${PORT}`);
  console.log(`    Site          → http://localhost:${PORT}`);
  console.log(`    Admin         → http://localhost:${PORT}/admin.html`);
  console.log(`    Admin token   → ${process.env.ADMIN_SECRET || 'qs-admin-2025'}\n`);
});
