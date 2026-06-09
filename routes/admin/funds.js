const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db/migrate');
const router = express.Router();

router.get('/funds', (req, res) => {
  const db = getDb();
  const funds = db.prepare('SELECT * FROM funds ORDER BY name').all();
  db.close();
  res.render('admin/funds', { funds, saved: req.query.saved });
});

router.get('/funds/new', (req, res) => {
  res.render('admin/fund-form', { fund: null, error: null });
});

router.get('/funds/:id/edit', (req, res) => {
  const db = getDb();
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  db.close();
  if (!fund) return res.status(404).render('error', { message: '找不到此基金', user: res.locals.user });
  res.render('admin/fund-form', { fund, error: null });
});

router.post('/funds', (req, res) => {
  const { id, name, inception_date, is_active } = req.body;
  if (!name || !name.trim()) {
    return res.render('admin/fund-form', { fund: req.body, error: '請填寫基金名稱' });
  }
  if (!inception_date) {
    return res.render('admin/fund-form', { fund: req.body, error: '請填寫成立日期' });
  }
  const db = getDb();
  const fundId = id || uuidv4();
  db.prepare(`
    INSERT INTO funds (id, name, inception_date, is_active)
    VALUES (@id, @name, @inception_date, @is_active)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, inception_date=excluded.inception_date, is_active=excluded.is_active
  `).run({
    id: fundId,
    name: name.trim(),
    inception_date,
    is_active: is_active === 'on' ? 1 : 0,
  });
  db.close();
  res.redirect('/admin/funds?saved=1');
});

router.post('/funds/:id/toggle', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE funds SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/funds');
});

router.post('/funds/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM funds WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/funds');
});

module.exports = router;
