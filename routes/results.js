const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/migrate');
const router = express.Router();

router.get('/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM check_sessions WHERE id = ?').get(req.params.id);
  db.close();

  if (!session) return res.status(404).render('error', { message: '找不到此檢查記錄', user: res.locals.user });

  // Only owner or admin can view
  if (session.user_id !== req.session.userId && req.session.role !== 'admin') {
    return res.status(403).render('error', { message: '無權限查看此記錄', user: res.locals.user });
  }

  let results = null, summary = null, fundDetail = null;
  try { results = session.results ? JSON.parse(session.results) : null; } catch {}
  try {
    summary = session.summary ? JSON.parse(session.summary) : null;
    fundDetail = (summary?.fundDetail || []).map(f => {
      if (Array.isArray(f.items)) return f;
      // Backward-compat: sessions checked before the fund_warning_items redesign
      // stored a flat { annotation_text, issues } shape instead of { items: [...] }
      const items = f.annotation_text
        ? [{ name: '加注文字', warning_text: f.annotation_text, ok: !(f.issues && f.issues.length), checks: [], issues: f.issues || [], format: null }]
        : [];
      return { ...f, items };
    });
  } catch {}

  res.render('result', { session, results, summary, fundDetail });
});

// Download outputs
router.get('/:id/download/checklist', (req, res) => {
  serveFile(req, res, 'checklist_output_path', 'checklist.docx');
});

router.get('/:id/download/annotated', (req, res) => {
  serveFile(req, res, 'annotated_output_path', 'annotated');
});

function serveFile(req, res, field, defaultName) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM check_sessions WHERE id = ?').get(req.params.id);
  db.close();
  if (!session) return res.status(404).send('Not found');
  if (session.user_id !== req.session.userId && req.session.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }
  const filePath = session[field];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('File not ready');
  const ext = path.extname(filePath);
  const filename = defaultName.includes('.') ? defaultName : defaultName + ext;
  res.download(filePath, filename);
}

module.exports = router;
