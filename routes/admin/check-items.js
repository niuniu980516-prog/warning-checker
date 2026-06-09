const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../db/migrate');
const { generateCheckPrompt } = require('../../lib/checker/ai');
const { AD_TYPES, parseAdTypes } = require('../../lib/ad-types');
const router = express.Router();

// Compact sort_order to a contiguous 1..N sequence, preserving relative order
function renumberCheckItems(db) {
  const items = db.prepare('SELECT id FROM check_items ORDER BY sort_order, id').all();
  const update = db.prepare('UPDATE check_items SET sort_order = ? WHERE id = ?');
  items.forEach((item, idx) => update.run(idx + 1, item.id));
}

// Normalizes a sub-item into the shape the form template renders, regardless
// of whether it came from the database (applicability_keywords/compliance_format
// as JSON strings, is_active as 0/1) or was just posted back after a validation
// error (applicability_keywords_text as raw text, format_* checkboxes as 'on').
function normalizeSubItemForView(sub) {
  sub = sub || {};
  const isPosted = 'applicability_keywords_text' in sub || 'format_bold' in sub;
  let applicabilityKeywordsText, complianceFormat, isActive;
  if (isPosted) {
    applicabilityKeywordsText = sub.applicability_keywords_text || '';
    complianceFormat = {
      bold: sub.format_bold === 'on',
      distinctive_color: sub.format_distinctive_color === 'on',
      bold_or_color: sub.format_bold_or_color === 'on',
      not_smallest: sub.format_not_smallest === 'on',
      same_size: sub.format_same_size === 'on',
      underline: sub.format_underline === 'on',
      immediately_after: sub.format_immediately_after === 'on',
      same_page: sub.format_same_page === 'on',
    };
    isActive = sub.is_active === 'on' || sub.is_active === undefined;
  } else {
    try { applicabilityKeywordsText = (JSON.parse(sub.applicability_keywords || '[]') || []).filter(Boolean).join('\n'); } catch { applicabilityKeywordsText = ''; }
    try { complianceFormat = JSON.parse(sub.compliance_format || '{}') || {}; } catch { complianceFormat = {}; }
    isActive = sub.is_active === undefined ? true : !!sub.is_active;
  }
  return {
    id: sub.id || '',
    description: sub.description || '',
    check_type: sub.check_type || 'ai',
    parameters: sub.parameters || '{}',
    applicability_prompt: sub.applicability_prompt || '',
    applicability_mode: sub.applicability_mode === 'keyword' ? 'keyword' : sub.applicability_mode === 'always' ? 'always' : 'ai',
    applicabilityKeywordsText,
    compliance_prompt: sub.compliance_prompt || '',
    compliance_mode: sub.compliance_mode === 'text_presence' ? 'text_presence' : 'ai',
    compliance_text: sub.compliance_text || '',
    complianceFormat,
    isActive,
  };
}

router.get('/check-items', (req, res) => {
  const db = getDb();
  const items = db.prepare('SELECT * FROM check_items ORDER BY sort_order').all();
  const subItems = db.prepare('SELECT * FROM check_sub_items ORDER BY check_item_id, sort_order, id').all();
  const categories = [...new Set(items.map(i => i.category))];
  db.close();

  const subItemsByParent = new Map();
  for (const sub of subItems) {
    if (!subItemsByParent.has(sub.check_item_id)) subItemsByParent.set(sub.check_item_id, []);
    subItemsByParent.get(sub.check_item_id).push(sub);
  }
  const itemsWithSubs = items.map(item => ({ ...item, subItems: subItemsByParent.get(item.id) || [] }));

  res.render('admin/check-items', { items: itemsWithSubs, categories, saved: req.query.saved });
});

router.get('/check-items/new', (req, res) => {
  const db = getDb();
  const categories = [...new Set(db.prepare('SELECT DISTINCT category FROM check_items').all().map(r => r.category))];
  db.close();
  res.render('admin/check-item-form', { item: null, subItems: [normalizeSubItemForView(null)], categories, adTypes: AD_TYPES, error: null });
});

router.get('/check-items/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM check_items WHERE id = ?').get(req.params.id);
  const subItems = item
    ? db.prepare('SELECT * FROM check_sub_items WHERE check_item_id = ? ORDER BY sort_order, id').all(item.id)
    : [];
  const categories = [...new Set(db.prepare('SELECT DISTINCT category FROM check_items').all().map(r => r.category))];
  db.close();
  if (!item) return res.status(404).render('error', { message: '找不到此項目', user: res.locals.user });
  res.render('admin/check-item-form', {
    item: { ...item, selectedAdTypes: parseAdTypes(item.ad_types) },
    subItems: (subItems.length ? subItems : [null]).map(normalizeSubItemForView),
    categories,
    adTypes: AD_TYPES,
    error: null,
  });
});

// AI-assisted generation of 適用性判斷／合規判斷標準 prompts (used by the form's "AI 生成" buttons)
router.post('/check-items/generate-prompt', async (req, res) => {
  const { description, category, field } = req.body || {};
  if (!description || !['applicability', 'compliance'].includes(field)) {
    return res.status(400).json({ error: '缺少檢查項目描述或欄位類型' });
  }
  try {
    const text = await generateCheckPrompt({ description, category, field });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI 生成失敗' });
  }
});

router.post('/check-items', (req, res) => {
  const { id, category, description, sort_order, is_active } = req.body;
  // qs (express's "extended" urlencoded parser) turns sub[0][x]=...&sub[1][x]=...
  // into req.body.sub = [{x:...}, {x:...}]
  const postedSubs = Array.isArray(req.body.sub) ? req.body.sub : Object.values(req.body.sub || {});
  // Posted ad_types may be a single string (one checkbox) or array (multiple)
  const selectedAdTypes = (Array.isArray(req.body.ad_types) ? req.body.ad_types : (req.body.ad_types ? [req.body.ad_types] : []))
    .filter(t => AD_TYPES.includes(t));

  const db = getDb();
  const rerender = (error) => {
    const categories = [...new Set(db.prepare('SELECT DISTINCT category FROM check_items').all().map(r => r.category))];
    db.close();
    return res.render('admin/check-item-form', {
      item: { id, category, description, sort_order, is_active, selectedAdTypes },
      subItems: (postedSubs.length ? postedSubs : [null]).map(normalizeSubItemForView),
      categories,
      adTypes: AD_TYPES,
      error,
    });
  };

  if (postedSubs.length === 0) return rerender('請至少設定一個子檢查項目');

  // Validate every sub-item's "parameters" JSON before writing anything
  const subs = [];
  for (const s of postedSubs) {
    let params;
    try {
      params = JSON.parse(s.parameters || '{}');
    } catch {
      return rerender('進階設定中的「參數」格式錯誤，請輸入有效的 JSON');
    }
    const applicabilityKeywords = (s.applicability_keywords_text || '')
      .split('\n').map(v => v.trim()).filter(Boolean);
    const complianceFormat = {
      bold: s.format_bold === 'on',
      distinctive_color: s.format_distinctive_color === 'on',
      bold_or_color: s.format_bold_or_color === 'on',
      not_smallest: s.format_not_smallest === 'on',
      same_size: s.format_same_size === 'on',
      underline: s.format_underline === 'on',
      immediately_after: s.format_immediately_after === 'on',
      same_page: s.format_same_page === 'on',
    };
    subs.push({
      id: s.id || uuidv4(),
      description: (s.description || '').trim() || null,
      check_type: s.check_type || 'ai',
      parameters: JSON.stringify(params),
      applicability_prompt: (s.applicability_prompt || '').trim() || null,
      applicability_mode: s.applicability_mode === 'keyword' ? 'keyword' : s.applicability_mode === 'always' ? 'always' : 'ai',
      applicability_keywords: JSON.stringify(applicabilityKeywords),
      compliance_prompt: (s.compliance_prompt || '').trim() || null,
      compliance_mode: s.compliance_mode === 'text_presence' ? 'text_presence' : 'ai',
      compliance_text: (s.compliance_text || '').trim(),
      compliance_format: JSON.stringify(complianceFormat),
      is_active: s.is_active === 'on' ? 1 : 0,
    });
  }

  const itemId = id || uuidv4();
  const upsertParent = db.prepare(`
    INSERT INTO check_items (id, category, description, is_active, sort_order, ad_types)
    VALUES (@id, @category, @description, @is_active, @sort_order, @ad_types)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, description=excluded.description,
      is_active=excluded.is_active, sort_order=excluded.sort_order, ad_types=excluded.ad_types
  `);
  const deleteSubItems = db.prepare('DELETE FROM check_sub_items WHERE check_item_id = ?');
  const insertSubItem = db.prepare(`
    INSERT INTO check_sub_items (id, check_item_id, description, check_type, parameters,
      applicability_prompt, applicability_mode, applicability_keywords,
      compliance_prompt, compliance_mode, compliance_text, compliance_format,
      sort_order, is_active)
    VALUES (@id, @check_item_id, @description, @check_type, @parameters,
      @applicability_prompt, @applicability_mode, @applicability_keywords,
      @compliance_prompt, @compliance_mode, @compliance_text, @compliance_format,
      @sort_order, @is_active)
  `);

  const save = db.transaction(() => {
    upsertParent.run({
      id: itemId, category, description,
      is_active: is_active === 'on' ? 1 : 0,
      sort_order: parseInt(sort_order) || 0,
      ad_types: JSON.stringify(selectedAdTypes),
    });
    deleteSubItems.run(itemId);
    subs.forEach((sub, idx) => insertSubItem.run({ ...sub, check_item_id: itemId, sort_order: idx + 1 }));
  });
  save();

  renumberCheckItems(db);
  db.close();
  res.redirect('/admin/check-items?saved=1');
});

router.post('/check-items/:id/toggle', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE check_items SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  db.close();
  res.redirect('/admin/check-items');
});

router.post('/check-items/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM check_items WHERE id = ?').run(req.params.id);
  renumberCheckItems(db);
  db.close();
  res.redirect('/admin/check-items');
});

module.exports = router;
