const { getDb } = require('../db/migrate');

// Persona/framing sentence prepended to every AI compliance-review prompt
// (item checks, applicability/compliance judgment, vision checks). Admin-editable
// via /admin/settings — this default matches the text that was previously hardcoded,
// so existing behavior is unchanged until an admin customizes it.
const DEFAULT_SYSTEM_PROMPT = '你是台灣基金廣告合規審查員';

function getSetting(key, fallback = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return (row && row.value) ? row.value : fallback;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  db.close();
}

function getSystemPrompt() {
  return getSetting('system_prompt', DEFAULT_SYSTEM_PROMPT);
}

module.exports = { getSetting, setSetting, getSystemPrompt, DEFAULT_SYSTEM_PROMPT };
