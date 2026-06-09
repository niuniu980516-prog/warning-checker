const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db/migrate');
const router = express.Router();

router.get('/fund-warnings', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  const funds = q
    ? db.prepare("SELECT * FROM fund_warnings WHERE fund_name LIKE ? OR aliases LIKE ? ORDER BY warning_category, fund_name").all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM fund_warnings ORDER BY warning_category, fund_name').all();
  db.close();
  const categories = [...new Set(funds.map(f => f.warning_category).filter(Boolean))];
  res.render('admin/fund-warnings', { funds, categories, q, saved: req.query.saved });
});

router.get('/fund-warnings/new', (req, res) => {
  const db = getDb();
  const categories = [...new Set(db.prepare('SELECT DISTINCT warning_category FROM fund_warnings').all().map(r => r.warning_category).filter(Boolean))];
  db.close();
  res.render('admin/fund-warning-form', { fund: null, items: [], categories, error: null });
});

router.get('/fund-warnings/:id/edit', (req, res) => {
  const db = getDb();
  const fund = db.prepare('SELECT * FROM fund_warnings WHERE id = ?').get(req.params.id);
  const items = fund
    ? db.prepare('SELECT * FROM fund_warning_items WHERE fund_id = ? ORDER BY sort_order').all(fund.id)
    : [];
  const categories = [...new Set(db.prepare('SELECT DISTINCT warning_category FROM fund_warnings').all().map(r => r.warning_category).filter(Boolean))];
  db.close();
  if (!fund) return res.status(404).render('error', { message: '找不到此基金', user: res.locals.user });
  res.render('admin/fund-warning-form', { fund, items, categories, error: null });
});

router.post('/fund-warnings', (req, res) => {
  const { id, fund_name, aliases, warning_category, is_active } = req.body;
  const db = getDb();
  // Parse aliases (one per line)
  const aliasArray = (aliases || '').split('\n').map(s => s.trim()).filter(Boolean);
  const fundId = id || uuidv4();

  // Warning items submitted as items[0][name], items[0][warning_text], items[0][match], items[0][fmt_*]
  const rawItems = Array.isArray(req.body.items) ? req.body.items : Object.values(req.body.items || {});
  const items = rawItems
    .filter(it => it && (it.name || '').trim() && (it.warning_text || '').trim())
    .map((it, idx) => ({
      id: uuidv4(),
      fund_id: fundId,
      name: it.name.trim(),
      warning_text: it.warning_text.trim(),
      require_immediately_after: it.match === 'after' ? 1 : 0,
      match_mode: ['after', 'anywhere', 'same_page', 'document_end'].includes(it.match) ? it.match : 'anywhere',
      format_requirements: JSON.stringify({
        bold: !!it.fmt_bold,
        not_smallest: !!it.fmt_not_smallest,
        bold_or_color: !!it.fmt_bold_or_color,
        same_size: !!it.fmt_size,
        underline: !!it.fmt_underline,
      }),
      sort_order: idx + 1,
    }));

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO fund_warnings (id, fund_name, aliases, warning_category, is_active)
      VALUES (@id, @fund_name, @aliases, @warning_category, @is_active)
      ON CONFLICT(id) DO UPDATE SET
        fund_name=excluded.fund_name, aliases=excluded.aliases,
        warning_category=excluded.warning_category, is_active=excluded.is_active
    `).run({
      id: fundId, fund_name, aliases: JSON.stringify(aliasArray),
      warning_category: warning_category || null,
      is_active: is_active === 'on' ? 1 : 0,
    });
    db.prepare('DELETE FROM fund_warning_items WHERE fund_id = ?').run(fundId);
    const insertItem = db.prepare(`
      INSERT INTO fund_warning_items (id, fund_id, name, warning_text, require_immediately_after, match_mode, format_requirements, sort_order)
      VALUES (@id, @fund_id, @name, @warning_text, @require_immediately_after, @match_mode, @format_requirements, @sort_order)
    `);
    for (const it of items) insertItem.run(it);
  });
  save();
  db.close();
  res.redirect('/admin/fund-warnings?saved=1');
});

router.post('/fund-warnings/:id/toggle', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE fund_warnings SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/fund-warnings');
});

router.post('/fund-warnings/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM fund_warnings WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/fund-warnings');
});

module.exports = router;
