const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/migrate');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/upload');
  res.render('login', { error: null, next: req.query.next || '/upload' });
});

router.post('/login', async (req, res) => {
  const { username, password, next } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '請輸入帳號與密碼', next: next || '/upload' });
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  db.close();

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: '帳號或密碼錯誤', next: next || '/upload' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;

  const db2 = getDb();
  db2.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
  db2.close();

  res.redirect(next || '/upload');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
