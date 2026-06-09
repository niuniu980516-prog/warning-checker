require('dotenv').config();
const express = require('express');
const session = require('express-session');
const ConnectSQLite = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');

const { migrate } = require('./db/migrate');
const { formatDateTime, formatDate } = require('./lib/datetime');

// Ensure DB + directories exist
migrate();
['uploads', 'outputs', 'data/db'].forEach(d =>
  fs.mkdirSync(path.join(__dirname, d), { recursive: true })
);

const app = express();
const PORT = process.env.PORT || 3005;

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes idle timeout

app.use(session({
  store: new ConnectSQLite({ db: 'sessions.db', dir: path.join(__dirname, 'data/db') }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // reset cookie expiry on each request
  cookie: {
    maxAge: SESSION_IDLE_MS,
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
  if (req.session?.userId && req.session?.role === 'admin') return next();
  res.status(403).render('error', { message: '需要管理員權限', user: req.session });
}

app.use((req, res, next) => {
  res.locals.user = req.session?.userId
    ? { id: req.session.userId, username: req.session.username, role: req.session.role }
    : null;
  res.locals.formatDateTime = formatDateTime;
  res.locals.formatDate = formatDate;
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/', requireAuth, require('./routes/upload'));
app.use('/results', requireAuth, require('./routes/results'));
app.use('/history', requireAuth, require('./routes/history'));
app.use('/admin', requireAdmin, require('./routes/admin/check-items'));
app.use('/admin', requireAdmin, require('./routes/admin/fund-warnings'));
app.use('/admin', requireAdmin, require('./routes/admin/funds'));
app.use('/admin', requireAdmin, require('./routes/admin/users'));
app.use('/admin', requireAdmin, require('./routes/admin/settings'));

// Root → upload page
app.get('/', requireAuth, (req, res) => res.redirect('/upload'));

// 404
app.use((req, res) => res.status(404).render('error', { message: '頁面不存在', user: res.locals.user }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: err.message || '系統錯誤', user: res.locals.user });
});

// ── Cleanup job: delete files older than FILE_RETENTION_DAYS ─────────────────
const RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS || '30');
function runCleanup() {
  const { getDb } = require('./db/migrate');
  const db = getDb();
  const expired = db.prepare(
    "SELECT id, file_path, checklist_output_path, annotated_output_path FROM check_sessions WHERE expires_at < datetime('now')"
  ).all();
  for (const row of expired) {
    for (const p of [row.file_path, row.checklist_output_path, row.annotated_output_path]) {
      if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  }
  db.prepare("DELETE FROM check_sessions WHERE expires_at < datetime('now')").run();
  db.close();
  if (expired.length > 0) console.log(`[cleanup] Removed ${expired.length} expired sessions`);
}
setInterval(runCleanup, 6 * 60 * 60 * 1000); // every 6h
setTimeout(runCleanup, 5000); // once on startup

app.listen(PORT, () => console.log(`Warning Checker running on port ${PORT}`));
