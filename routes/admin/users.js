const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db/migrate');
const router = express.Router();

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, role, is_active, created_at FROM users ORDER BY created_at DESC').all();
  db.close();
  res.render('admin/users', { users, saved: req.query.saved, error: null });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { user: null, error: null });
});

router.get('/users/:id/edit', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(req.params.id);
  db.close();
  if (!user) return res.status(404).render('error', { message: '找不到此使用者', user: res.locals.user });
  res.render('admin/user-form', { user, error: null });
});

router.post('/users', async (req, res) => {
  const { id, username, password, role, is_active } = req.body;
  const db = getDb();

  if (!username || username.trim().length < 3) {
    db.close();
    return res.render('admin/user-form', { user: req.body, error: '帳號至少需 3 個字元' });
  }

  try {
    if (id) {
      // Update existing user
      const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
      if (existing) {
        db.close();
        return res.render('admin/user-form', { user: req.body, error: '帳號已存在' });
      }
      if (password && password.length > 0) {
        if (password.length < 8) {
          db.close();
          return res.render('admin/user-form', { user: req.body, error: '密碼至少需 8 個字元' });
        }
        const hash = await bcrypt.hash(password, 10);
        db.prepare('UPDATE users SET username=?, password_hash=?, role=?, is_active=? WHERE id=?')
          .run(username, hash, role || 'user', is_active === 'on' ? 1 : 0, id);
      } else {
        db.prepare('UPDATE users SET username=?, role=?, is_active=? WHERE id=?')
          .run(username, role || 'user', is_active === 'on' ? 1 : 0, id);
      }
    } else {
      // Create new user
      if (!password || password.length < 8) {
        db.close();
        return res.render('admin/user-form', { user: req.body, error: '密碼至少需 8 個字元' });
      }
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        db.close();
        return res.render('admin/user-form', { user: req.body, error: '帳號已存在' });
      }
      const hash = await bcrypt.hash(password, 10);
      db.prepare('INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)')
        .run(uuidv4(), username, hash, role || 'user', is_active === 'on' ? 1 : 0);
    }
    db.close();
    res.redirect('/admin/users?saved=1');
  } catch (err) {
    db.close();
    res.render('admin/user-form', { user: req.body, error: err.message });
  }
});

router.post('/users/:id/toggle', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE users SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  // Prevent self-deletion
  if (req.params.id === req.session.userId) {
    return res.redirect('/admin/users');
  }
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/users');
});

module.exports = router;
