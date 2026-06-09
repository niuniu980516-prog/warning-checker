const express = require('express');
const fs = require('fs');
const { getDb } = require('../db/migrate');
const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const isAdmin = req.session.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`SELECT s.*, u.username FROM check_sessions s LEFT JOIN users u ON s.user_id = u.id ORDER BY s.created_at DESC LIMIT 100`).all()
    : db.prepare(`SELECT * FROM check_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(req.session.userId);
  db.close();

  const sessions = rows.map(r => {
    let summary = null;
    try { summary = r.summary ? JSON.parse(r.summary) : null; } catch {}
    return { ...r, summary };
  });

  res.render('history', { sessions, isAdmin, deleted: req.query.deleted });
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const isAdmin = req.session.role === 'admin';
  const session = isAdmin
    ? db.prepare('SELECT * FROM check_sessions WHERE id = ?').get(req.params.id)
    : db.prepare('SELECT * FROM check_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);

  if (!session) {
    db.close();
    return res.redirect('/history');
  }

  // Delete output files
  for (const p of [session.checklist_output_path, session.annotated_output_path, session.file_path]) {
    if (p) try { fs.unlinkSync(p); } catch {}
  }
  // Also try to remove the tmp dir
  if (session.checklist_output_path) {
    try { fs.rmdirSync(require('path').dirname(session.checklist_output_path)); } catch {}
  }

  db.prepare('DELETE FROM check_sessions WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/history?deleted=1');
});

module.exports = router;
