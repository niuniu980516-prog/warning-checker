#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/migrate');

function cleanup() {
  const db = getDb();
  const now = new Date().toISOString();

  // Find expired sessions
  const expired = db.prepare("SELECT * FROM check_sessions WHERE expires_at < ?").all(now);

  let deleted = 0;
  for (const session of expired) {
    // Delete files
    for (const field of ['file_path', 'checklist_output_path', 'annotated_output_path']) {
      if (session[field] && fs.existsSync(session[field])) {
        try { fs.unlinkSync(session[field]); } catch {}
      }
    }
    // Delete session output directory
    const outputDir = path.join(__dirname, '../outputs', session.id);
    if (fs.existsSync(outputDir)) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
    }
    deleted++;
  }

  // Remove from DB
  db.prepare("DELETE FROM check_sessions WHERE expires_at < ?").run(now);
  db.close();

  if (deleted > 0) {
    console.log(`[cleanup] Deleted ${deleted} expired sessions.`);
  }
}

cleanup();
