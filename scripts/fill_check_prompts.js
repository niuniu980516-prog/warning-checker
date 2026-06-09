/**
 * One-off batch job: generate 適用性判斷／合規判斷標準 for every existing check_sub_items
 * row that doesn't have them yet, using the same generateCheckPrompt() the admin
 * form's "AI 生成" buttons call. Run inside the container: node scripts/fill_check_prompts.js
 */
require('dotenv').config();
const { getDb } = require('../db/migrate');
const { generateCheckPrompt } = require('../lib/checker/ai');

const CONCURRENCY = 3;

async function processItem(item, update, index, total) {
  try {
    const [applicability, compliance] = await Promise.all([
      generateCheckPrompt({ category: item.category, description: item.description, field: 'applicability' }),
      generateCheckPrompt({ category: item.category, description: item.description, field: 'compliance' }),
    ]);
    update.run(applicability, compliance, item.id);
    console.log(`[${index}/${total}] ${item.id}`);
    console.log(`  適用: ${applicability}`);
    console.log(`  合規: ${compliance}`);
  } catch (e) {
    console.error(`[${index}/${total}] FAIL ${item.id}: ${e.message}`);
  }
}

async function run() {
  const db = getDb();
  const items = db.prepare(`
    SELECT s.id AS id, ci.category AS category, COALESCE(s.description, ci.description) AS description
    FROM check_sub_items s
    JOIN check_items ci ON ci.id = s.check_item_id
    WHERE s.applicability_prompt IS NULL OR s.compliance_prompt IS NULL
    ORDER BY ci.sort_order, s.sort_order
  `).all();
  console.log(`待處理 ${items.length} 筆`);
  const update = db.prepare('UPDATE check_sub_items SET applicability_prompt = ?, compliance_prompt = ? WHERE id = ?');

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      await processItem(items[idx], update, idx + 1, items.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  db.close();
  console.log('全部完成');
}

run().catch(e => { console.error(e); process.exit(1); });
