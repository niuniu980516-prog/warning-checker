const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '../data/db/checker.db');

function getDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS check_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      check_type TEXT NOT NULL,
      group_name TEXT,
      preconditions TEXT DEFAULT '[]',
      parameters TEXT DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- A checklist entry (序號) sometimes decomposes into multiple independent
    -- sub-checks — e.g. 適用性判斷與合規判斷標準各不相同的兩種情境 — each
    -- evaluated on its own (own applicability + compliance judgment, own result
    -- row). 1 check_item -> N check_sub_items; description is an optional
    -- override (NULL falls back to the parent's description).
    CREATE TABLE IF NOT EXISTS check_sub_items (
      id TEXT PRIMARY KEY,
      check_item_id TEXT NOT NULL REFERENCES check_items(id) ON DELETE CASCADE,
      description TEXT,
      check_type TEXT NOT NULL DEFAULT 'ai',
      parameters TEXT DEFAULT '{}',
      applicability_prompt TEXT,
      applicability_mode TEXT NOT NULL DEFAULT 'ai',
      applicability_keywords TEXT DEFAULT '[]',
      compliance_prompt TEXT,
      compliance_mode TEXT NOT NULL DEFAULT 'ai',
      compliance_text TEXT DEFAULT '',
      compliance_format TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_check_sub_items_parent ON check_sub_items(check_item_id);

    CREATE TABLE IF NOT EXISTS fund_warnings (
      id TEXT PRIMARY KEY,
      fund_name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      annotation_text TEXT,
      annotation_format TEXT DEFAULT '{"bold":true,"distinctive_color":true,"same_size":true,"immediately_after":true}',
      comprehensive_warning TEXT,
      warning_category TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    -- One fund can require checking for any number of distinct warning texts
    -- (e.g. 加注文字／綜合警語／風險等級標示／配息來源警語…), each with its own
    -- matching rule (緊接基金名稱之後 vs 全文任意處出現) and format requirements.
    CREATE TABLE IF NOT EXISTS fund_warning_items (
      id TEXT PRIMARY KEY,
      fund_id TEXT NOT NULL REFERENCES fund_warnings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      warning_text TEXT NOT NULL,
      require_immediately_after INTEGER NOT NULL DEFAULT 0,
      format_requirements TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_fund_warning_items_fund ON fund_warning_items(fund_id);

    CREATE TABLE IF NOT EXISTS warning_texts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_keywords TEXT DEFAULT '[]',
      trigger_type TEXT NOT NULL DEFAULT 'semantic',
      warning_text TEXT NOT NULL,
      placement_rule TEXT NOT NULL DEFAULT 'same_page',
      format_requirements TEXT DEFAULT '{"bold":true}',
      preconditions TEXT DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS forbidden_terms (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      term TEXT NOT NULL,
      semantic_group TEXT DEFAULT '[]',
      exception_rule TEXT,
      check_item_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (check_item_id) REFERENCES check_items(id)
    );

    CREATE TABLE IF NOT EXISTS check_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      results TEXT,
      summary TEXT,
      checklist_output_path TEXT,
      annotated_output_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      expires_at TEXT,
      error_message TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON check_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON check_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON check_sessions(expires_at);

    -- Admin-adjustable settings (key/value), e.g. the AI system prompt persona
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Fund registry: name + inception date, used to determine performance disclosure eligibility
    CREATE TABLE IF NOT EXISTS funds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      inception_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Add missing columns to existing tables (idempotent)
  try { db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE check_sessions ADD COLUMN format TEXT"); } catch {}
  try { db.exec("ALTER TABLE check_sessions ADD COLUMN ocr_used INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN applicability_prompt TEXT"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN compliance_prompt TEXT"); } catch {}
  // Structured (non-JSON) alternatives to AI-prompt-based applicability/compliance judgment —
  // 'keyword' mode applies the item only when specific text appears; 'text_presence' mode
  // judges compliance by whether specific warning text appears (with format requirements),
  // letting non-technical admins configure checks without writing AI prompts or JSON parameters.
  try { db.exec("ALTER TABLE check_items ADD COLUMN applicability_mode TEXT NOT NULL DEFAULT 'ai'"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN applicability_keywords TEXT DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN compliance_mode TEXT NOT NULL DEFAULT 'ai'"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN compliance_text TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE check_items ADD COLUMN compliance_format TEXT DEFAULT '{}'"); } catch {}
  // preconditions on check_items was never read by the checking pipeline — drop it
  try { db.exec("ALTER TABLE check_items DROP COLUMN preconditions"); } catch {}

  // fund_warning_items: richer 比對方式 (match_mode) replacing the boolean
  // require_immediately_after. Values: 'after' (緊接基金名稱之後), 'anywhere'
  // (全文任意處), 'same_page' (出現在當頁/與基金名稱同頁), 'document_end' (出現在文宣最後面).
  const hadMatchMode = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('fund_warning_items') WHERE name='match_mode'").get().c > 0;
  if (!hadMatchMode) {
    try {
      db.exec("ALTER TABLE fund_warning_items ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'anywhere'");
      db.exec("UPDATE fund_warning_items SET match_mode = 'after' WHERE require_immediately_after = 1");
    } catch {}
  }

  // Ad-type applicability: an upload can be tagged with one or more 廣告類型, and
  // each check item can declare which 廣告類型 it applies to. Stored as JSON arrays.
  // Empty array on a check item = applies to ALL ad types (no restriction).
  try { db.exec("ALTER TABLE check_items ADD COLUMN ad_types TEXT DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE check_sessions ADD COLUMN ad_types TEXT DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE check_sessions ADD COLUMN fund_id TEXT REFERENCES funds(id)"); } catch {}

  // One-time schema redesign: check_items used to carry exactly one
  // check_type/applicability/compliance configuration per row. Move that
  // configuration into check_sub_items (1 check_item -> N sub items, each
  // independently evaluated), then drop the now-unused columns from check_items.
  const stillHasOldCheckItemCols = db.prepare(
    "SELECT COUNT(*) AS c FROM pragma_table_info('check_items') WHERE name = 'check_type'"
  ).get().c > 0;
  if (stillHasOldCheckItemCols) {
    const items = db.prepare('SELECT * FROM check_items').all();
    const insertSubItem = db.prepare(`
      INSERT INTO check_sub_items (id, check_item_id, check_type, parameters,
        applicability_prompt, applicability_mode, applicability_keywords,
        compliance_prompt, compliance_mode, compliance_text, compliance_format,
        sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `);
    for (const ci of items) {
      insertSubItem.run(
        uuidv4(), ci.id, ci.check_type, ci.parameters,
        ci.applicability_prompt, ci.applicability_mode, ci.applicability_keywords,
        ci.compliance_prompt, ci.compliance_mode, ci.compliance_text, ci.compliance_format
      );
    }
    db.exec(`
      ALTER TABLE check_items DROP COLUMN check_type;
      ALTER TABLE check_items DROP COLUMN parameters;
      ALTER TABLE check_items DROP COLUMN applicability_prompt;
      ALTER TABLE check_items DROP COLUMN applicability_mode;
      ALTER TABLE check_items DROP COLUMN applicability_keywords;
      ALTER TABLE check_items DROP COLUMN compliance_prompt;
      ALTER TABLE check_items DROP COLUMN compliance_mode;
      ALTER TABLE check_items DROP COLUMN compliance_text;
      ALTER TABLE check_items DROP COLUMN compliance_format;
    `);
    console.log(`Migrated ${items.length} check_items rows into check_sub_items (one-time schema redesign).`);
  }

  // One-time schema redesign: fund_warnings used to hard-code exactly two warning
  // slots (annotation_text / comprehensive_warning). Convert each fund's existing
  // values into rows of the new fund_warning_items table (1 fund -> N items), then
  // drop the now-unused fixed columns.
  const stillHasOldCols = db.prepare(
    "SELECT COUNT(*) AS c FROM pragma_table_info('fund_warnings') WHERE name = 'annotation_text'"
  ).get().c > 0;
  if (stillHasOldCols) {
    const funds = db.prepare('SELECT * FROM fund_warnings').all();
    const insertItem = db.prepare(`
      INSERT INTO fund_warning_items (id, fund_id, name, warning_text, require_immediately_after, format_requirements, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const fw of funds) {
      let order = 1;
      if (fw.annotation_text) {
        let fmt = {};
        try { fmt = JSON.parse(fw.annotation_format || '{}'); } catch {}
        insertItem.run(
          uuidv4(), fw.id, '加注文字', fw.annotation_text,
          fmt.immediately_after ? 1 : 0,
          JSON.stringify({ bold: !!fmt.bold, distinctive_color: !!fmt.distinctive_color, same_size: !!fmt.same_size }),
          order++
        );
      }
      if (fw.comprehensive_warning) {
        insertItem.run(uuidv4(), fw.id, '綜合警語', fw.comprehensive_warning, 0, '{}', order++);
      }
    }
    db.exec(`
      ALTER TABLE fund_warnings DROP COLUMN annotation_text;
      ALTER TABLE fund_warnings DROP COLUMN annotation_format;
      ALTER TABLE fund_warnings DROP COLUMN comprehensive_warning;
    `);
    console.log(`Migrated ${funds.length} fund_warnings rows into fund_warning_items (one-time schema redesign).`);
  }

  // Create default admin account if no users exist yet
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, is_active)
      VALUES (?, 'admin', ?, 'admin', 1)
    `).run(uuidv4(), bcrypt.hashSync('Admin1234!', 10));
    console.log('Created default admin user (admin / Admin1234!)');
  }

  console.log('Database migration completed.');
  return db;
}

module.exports = { getDb, migrate };
