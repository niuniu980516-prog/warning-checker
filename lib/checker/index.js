/**
 * Main checker orchestrator
 * Coordinates auto checks + AI grouped checks
 */
const { runAutoChecks, getFundAnnotationDetail } = require('./auto');
const { runAiChecks, runVisionChecks, transcribeImagesText } = require('./ai');
const { getDb } = require('../../db/migrate');
const { itemAppliesToAdTypes, parseAdTypes } = require('../ad-types');

// Visual layout checking is folded INTO the relevant check item's own result
// (rather than appearing as a separate standalone "視覺排版檢查" entry) — this
// lets PDF/PPTX submissions (which have no DOCX run-level style info) get a
// pass/fail verdict on format requirements (粗體／字體大小／位置…) straight from
// the page-image vision analysis, attributed to the actual check item it concerns.
//
// `pageLookup(item)` returns the page numbers relevant to a given item (e.g. the
// pages where its warning text or fund name appears); the vision findings for
// those specific pages are folded into that item's result.
function mergeVisionIntoResult(existingResult, relevantPages, visionByPage, contextLabel) {
  if (!relevantPages || relevantPages.length === 0) return existingResult;
  const findings = relevantPages.map(p => visionByPage.get(p)).filter(Boolean);
  if (findings.length === 0) return existingResult;

  const failing = findings.filter(f => f.pass === false);
  const usable = findings.filter(f => f.pass !== null && !f.skipped);
  if (usable.length === 0) return existingResult; // vision had nothing useful — keep original

  if (failing.length > 0) {
    return {
      ...existingResult,
      pass: false,
      skipped: false,
      violation: `視覺版面檢查發現${contextLabel}格式疑慮（第 ${failing.map(f => f.page).join('、')} 頁）`,
      details: failing.map(f => `第${f.page}頁：${f.details || f.reason || ''}`).join('；'),
      pages: [...new Set([...(existingResult.pages || []), ...failing.map(f => f.page)])],
      visionChecked: true,
    };
  }
  return {
    ...existingResult,
    pass: true,
    skipped: false,
    reason: `視覺版面檢查確認${contextLabel}格式符合規定（第 ${usable.map(f => f.page).join('、')} 頁）`,
    visionChecked: true,
  };
}

async function checkDocument(extractedData, options = {}) {
  let { pages, fullText, paragraphs, minFontSize, format, images } = extractedData;
  const selectedAdTypes = Array.isArray(options.adTypes) ? options.adTypes : [];
  const docxStructure = (format === 'docx' || format === 'doc') ? { paragraphs, minFontSize } : null;

  // ── Multimodal extraction of text embedded in images (#12) ──────────────────
  // Plain OCR often garbles stylised text inside marketing images/graphics.
  // For documents containing page images, ask a multimodal model to transcribe
  // every visible piece of text (including in-image text), then merge it into
  // each page's text / fullText so fund-warning and required-text checks — which
  // all match against this text — can "see" content that lives only in images.
  if (images && images.length > 0) {
    try {
      const transcriptions = await transcribeImagesText(images);
      if (transcriptions.length > 0) {
        const byPage = new Map(transcriptions.map(t => [t.page, t.text]));
        pages = pages.map(pg => {
          const extra = byPage.get(pg.page);
          return extra ? { ...pg, text: `${pg.text}\n${extra}` } : pg;
        });
        fullText = pages.map(p => p.text).join('\n');
      }
    } catch (e) {
      console.warn('Multimodal image text transcription failed:', e.message);
    }
  }

  // Load all active check items, flattened to one evaluable entry per active
  // sub-item — a single 序號 (check_items row) may decompose into several
  // independently-judged sub-checks (check_sub_items), each with its own
  // applicability/compliance configuration and its own pass/fail result.
  // Downstream (auto/ai checkers, result view, docx report) only ever sees
  // this flat shape, keyed by the sub-item's id.
  const db = getDb();
  const parents = db.prepare('SELECT * FROM check_items WHERE is_active = 1 ORDER BY sort_order').all();
  const subItemsByParent = new Map();
  for (const sub of db.prepare('SELECT * FROM check_sub_items WHERE is_active = 1 ORDER BY sort_order, id').all()) {
    if (!subItemsByParent.has(sub.check_item_id)) subItemsByParent.set(sub.check_item_id, []);
    subItemsByParent.get(sub.check_item_id).push(sub);
  }
  db.close();

  // Only keep items whose parent applies to the selected ad types (empty parent
  // ad_types = applies to all; empty selection = no filtering).
  const applicableParents = parents.filter(parent =>
    itemAppliesToAdTypes(parseAdTypes(parent.ad_types), selectedAdTypes));

  const allItems = applicableParents.flatMap(parent => (subItemsByParent.get(parent.id) || []).map(sub => ({
    ...sub,
    category: parent.category,
    description: sub.description || parent.description,
  })));

  const autoResults = await runAutoChecks(allItems, pages, fullText, docxStructure);

  const useGemini = (process.env.LLM_PROVIDER || '').toLowerCase() === 'gemini';
  let aiResults, visionResults;
  if (useGemini) {
    // Cloud API — text and vision calls don't compete for local resources
    [aiResults, visionResults] = await Promise.all([
      runAiChecks(allItems, pages, fullText, docxStructure),
      runVisionChecks(images || []),
    ]);
  } else {
    // Ollama CPU can only handle one model at a time — must run sequentially
    aiResults = await runAiChecks(allItems, pages, fullText, docxStructure);
    visionResults = await runVisionChecks(images || []);
  }

  const allResults = [...autoResults, ...aiResults];

  // Map results back to check items
  const resultMap = {};
  for (const r of allResults) resultMap[r.check_id] = r;

  // ── Fold per-page vision findings into the relevant check items ─────────────
  // Visual layout checking is performed WITHIN each check item that needs it
  // (not as a separate standalone "視覺排版檢查" pass). For PDF/PPTX uploads —
  // which lack DOCX run-level style info — the items concerned with 警語字體
  // 格式（粗體／大小） and 基金名稱加注格式 get their pass/fail verdict directly
  // from the page-image vision analysis, scoped to the pages where their
  // relevant text actually appears.
  const visionByPage = new Map(visionResults.map(r => [r.page, r]).filter(([p]) => p !== undefined));
  const needsVisualConfirmation = (r) => r && r.pass === null && /視覺/.test(r.reason || '');

  if (visionByPage.size > 0 && !docxStructure) {
    for (const item of allItems) {
      const params = typeof item.parameters === 'string' ? JSON.parse(item.parameters || '{}') : (item.parameters || {});
      const r = resultMap[item.id];
      if (params?.type === 'warning_font_format' && needsVisualConfirmation(r)) {
        // Fold vision findings for whichever pages actually contain warning-like text
        const candidatePages = pages
          .filter(pg => /投資一定有風險|申購前應詳閱|警語/.test(pg.text))
          .map(pg => pg.page);
        const merged = mergeVisionIntoResult(r, candidatePages.length ? candidatePages : pages.map(p => p.page), visionByPage, '警語字體（粗體／大小）');
        if (merged !== r) resultMap[item.id] = merged;
      }
    }
  }

  const allResultsAfterVision = Object.values(resultMap);
  const total = allResultsAfterVision.filter(r => r.pass !== null && !r.skipped).length;
  const passed = allResultsAfterVision.filter(r => r.pass === true).length;
  const failed = allResultsAfterVision.filter(r => r.pass === false).length;
  const skipped = allResultsAfterVision.filter(r => r.skipped).length;
  const errors = allResultsAfterVision.filter(r => r.error).length;

  const itemResults = allItems.map(item => ({
    ...item,
    parameters: typeof item.parameters === 'string' ? JSON.parse(item.parameters) : item.parameters,
    result: resultMap[item.id] || { pass: null, skipped: true, reason: '未執行' },
  }));

  const fundDetail = getFundAnnotationDetail(pages, fullText, docxStructure);

  // Fold vision findings into fund-annotation format verdicts that needed
  // visual confirmation (PDF/PPTX — format.pass === null), scoped to the pages
  // where each fund's name (and thus its required annotation) appears.
  if (visionByPage.size > 0 && !docxStructure) {
    for (const entry of fundDetail) {
      for (const it of entry.items) {
        if (it.format && it.format.pass === null) {
          const relevantPages = (it.pages && it.pages.length) ? it.pages : entry.pages;
          const findings = (relevantPages || []).map(p => visionByPage.get(p)).filter(f => f && f.pass !== null && !f.skipped);
          if (findings.length === 0) continue;
          const failing = findings.filter(f => f.pass === false);
          if (failing.length > 0) {
            it.format = { pass: false, reason: `視覺版面檢查發現「${it.name}」加注文字格式疑慮（第 ${failing.map(f => f.page).join('、')} 頁）` };
            it.ok = false;
            it.issues = [...(it.issues || []), it.format.reason];
          } else {
            it.format = { pass: true, reason: `視覺版面檢查確認「${it.name}」加注文字格式符合規定（第 ${findings.map(f => f.page).join('、')} 頁）` };
            it.checks = [...(it.checks || []), it.format.reason];
          }
        }
      }
    }
  }

  return {
    summary: {
      total,
      passed,
      failed,
      skipped,
      errors,
      fundDetail,
    },
    itemResults,
    rawResults: [...allResultsAfterVision, ...visionResults],
  };
}

module.exports = { checkDocument };
