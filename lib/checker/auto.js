/**
 * Program-based (auto) checks — no AI required
 * Handles: keyword matching, required text, font/bold format, fund annotation presence
 */
const { normalizedIncludes, fuzzyIncludes, splitIntoPhrases, normalize, compactNormalize } = require('../normalizer');
const { getDb } = require('../../db/migrate');

// ── Helper: find keyword in pages ────────────────────────────────────────────

function findKeywordInPages(pages, keywords) {
  const hits = [];
  for (const pg of pages) {
    const text = normalize(pg.text);
    for (const kw of keywords) {
      const normKw = normalize(kw);
      if (text.includes(normKw)) {
        hits.push({ page: pg.page, keyword: kw, context: getContext(pg.text, normKw) });
      }
    }
  }
  return hits;
}

function getContext(text, keyword, radius = 30) {
  const idx = normalize(text).indexOf(normalize(keyword));
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * Find which pages contain (most of) a long text passage, by checking what
 * fraction of its phrase-segments appear on each page. Used to report where
 * a comprehensive warning physically appears (it may span/repeat across pages).
 */
function findTextPages(pages, text, minPhraseLen = 15) {
  const phrases = splitIntoPhrases(text, minPhraseLen).map(p => compactNormalize(p)).filter(Boolean);
  if (phrases.length === 0) return [];
  const matched = [];
  for (const pg of pages) {
    const compactPage = compactNormalize(pg.text);
    const matchCount = phrases.filter(p => compactPage.includes(p)).length;
    if (matchCount >= Math.ceil(phrases.length * 0.5)) matched.push(pg.page);
  }
  return matched;
}

// ── Check: forbidden keywords ─────────────────────────────────────────────────

function checkForbiddenKeywords(item, pages) {
  const { keywords, violation } = item.parameters;
  const hits = findKeywordInPages(pages, keywords);
  if (hits.length === 0) return {
    pass: true,
    reason: `全文未發現禁用詞（${keywords.slice(0, 5).join('、')}${keywords.length > 5 ? '…等' : ''}）`,
  };
  return {
    pass: false,
    violation,
    details: hits.map(h => `第${h.page}頁「${h.keyword}」：${h.context}`).join('；'),
    pages: [...new Set(hits.map(h => h.page))],
  };
}

// ── Check: required text ──────────────────────────────────────────────────────

function checkRequiredText(item, pages, fullText) {
  const { required_keywords, violation } = item.parameters;
  const found = required_keywords.filter(kw => normalizedIncludes(fullText, kw));
  if (found.length > 0) return {
    pass: true,
    reason: `已發現必要文字「${found.join('、')}」`,
  };
  return {
    pass: false,
    violation,
    details: `未發現必要文字（${required_keywords.join('、')}）`,
    pages: [],
  };
}

// ── Check: conditional required ───────────────────────────────────────────────

function checkConditionalRequired(item, pages, fullText) {
  const { trigger_keywords, required_keywords, violation } = item.parameters;
  const triggeredKw = trigger_keywords.find(kw => normalizedIncludes(fullText, kw));
  if (!triggeredKw) return {
    pass: null,
    skipped: true,
    reason: `文宣未提及「${trigger_keywords.slice(0, 3).join('、')}」，本項不適用`,
  };

  const foundKw = required_keywords.find(kw => normalizedIncludes(fullText, kw));
  if (foundKw) return {
    pass: true,
    reason: `文中含有「${triggeredKw}」，已確認對應必要文字「${foundKw}」存在`,
  };
  return {
    pass: false,
    violation,
    details: `文中含有「${triggeredKw}」，但未發現對應必要文字（${required_keywords.join('、')}）`,
    pages: [],
  };
}

// ── Check: warning font format (DOCX only) ────────────────────────────────────

function checkWarningFontFormat(item, docxStructure, warningTexts) {
  if (!docxStructure || !docxStructure.paragraphs) {
    return { pass: null, skipped: true, reason: '僅適用於 DOCX/DOC 格式，PDF/PPT 需由 AI 判斷' };
  }
  const { require_bold, require_not_smallest } = item.parameters;
  const { paragraphs, minFontSize } = docxStructure;

  const issues = [];
  const db = getDb();
  const allWarningTexts = db.prepare('SELECT warning_text FROM warning_texts WHERE is_active = 1').all();
  const allFundWarningItems = db.prepare('SELECT warning_text FROM fund_warning_items WHERE is_active = 1').all();
  db.close();

  // Collect all warning text snippets to identify warning paragraphs
  const warningSnippets = [
    ...allWarningTexts.map(w => normalize(w.warning_text).slice(0, 20)),
    ...allFundWarningItems.map(w => normalize(w.warning_text).slice(0, 20)),
    normalize('投資一定有風險').slice(0, 12),
    normalize('本基金經金管會').slice(0, 10),
    normalize('申購前應詳閱').slice(0, 8),
  ];

  for (const para of paragraphs) {
    const normText = normalize(para.text);
    const isWarning = warningSnippets.some(s => normText.includes(s));
    if (!isWarning) continue;

    for (const run of para.runs) {
      if (!run.text.trim()) continue;
      if (require_bold && !run.bold) {
        issues.push(`警語「${run.text.slice(0, 20)}…」未以粗體標示`);
      }
      if (require_not_smallest && run.fontSize && minFontSize && run.fontSize <= minFontSize) {
        issues.push(`警語「${run.text.slice(0, 20)}…」字體大小（${run.fontSize}pt）為文宣最小字體`);
      }
    }
  }

  if (issues.length === 0) return {
    pass: true,
    reason: '警語段落均符合粗體及字體大小規定',
  };
  return { pass: false, violation: issues[0], details: issues.join('；'), pages: [] };
}

// Format requirement keys understood across both fund-warning items and check
// sub-items: 粗體(bold)、底線(underline)、字不能最小(not_smallest)、
// 粗體或顯著顏色(bold_or_color)、顯著顏色(distinctive_color)、字體相同大小(same_size).
const FORMAT_KEYS = ['bold', 'underline', 'not_smallest', 'bold_or_color', 'distinctive_color', 'same_size'];

function hasAnyFormatRequirement(fmt) {
  return !!fmt && FORMAT_KEYS.some(k => fmt[k]);
}

// Locate the DOCX run that carries `text` (returns { para, run } or { error }).
function findRunForText(docxStructure, text) {
  const para = docxStructure.paragraphs.find(p => normalizedIncludes(p.text, text));
  if (!para) return { error: 'no_para' };
  const run = para.runs.find(r => r.text.trim() && normalizedIncludes(r.text, text.slice(0, 8)))
    || para.runs.find(r => r.text.trim());
  if (!run) return { error: 'no_run' };
  return { para, run };
}

/**
 * Evaluate every configured format requirement (粗體／底線／不能最小／粗體或顯著顏色／
 * 顯著顏色／相同大小) for the DOCX run carrying `text`. Only possible for DOCX (we have
 * run-level style info); PDF/PPTX must fall back to the visual layout check.
 * `opts.referenceSize` (font size of the anchor, e.g. the fund name) enables the
 * 字體相同大小 check. Returns { checked, pass, reason } — pass=null when undeterminable.
 */
function evaluateRunFormat(docxStructure, text, fmt, opts = {}) {
  if (!hasAnyFormatRequirement(fmt)) return { checked: false, pass: null, reason: null };
  if (!docxStructure || !docxStructure.paragraphs) {
    return { checked: false, pass: null, reason: '格式（粗體／底線／顯著顏色／字級）需由視覺版面檢查確認，PDF/PPT 無法由程式直接核對文字樣式' };
  }
  const loc = findRunForText(docxStructure, text);
  if (loc.error) return { checked: true, pass: null, reason: '找不到警語文字所在段落／文字區塊，無法核對格式' };
  const run = loc.run;
  const hasBold = !!run.bold;
  const hasUnderline = !!run.underline;
  const hasColor = !!(run.color && run.color.toLowerCase() !== 'auto' && run.color.toLowerCase() !== '000000');

  const issues = [];
  const oks = [];
  if (fmt.bold) (hasBold ? oks.push('粗體') : issues.push('未以粗體標示'));
  if (fmt.underline) (hasUnderline ? oks.push('底線') : issues.push('未加底線'));
  if (fmt.bold_or_color) ((hasBold || hasColor) ? oks.push('粗體或顯著顏色') : issues.push('未以粗體或顯著顏色標示'));
  if (fmt.distinctive_color) ((hasColor || hasBold) ? oks.push('顯著顏色') : issues.push('未以顯著顏色標示'));
  if (fmt.not_smallest) {
    if (run.fontSize && docxStructure.minFontSize && run.fontSize <= docxStructure.minFontSize) {
      issues.push(`字體大小（${run.fontSize}pt）為文宣最小字體`);
    } else if (run.fontSize) {
      oks.push('非最小字體');
    }
  }
  if (fmt.same_size) {
    const ref = opts.referenceSize;
    if (ref && run.fontSize) {
      if (Math.abs(run.fontSize - ref) > 0.5) issues.push(`字體大小（${run.fontSize}pt）與基金名稱字體（${ref}pt）不一致`);
      else oks.push('與基金名稱字級相同');
    } else {
      oks.push('字級相同需另行確認（缺對照字級）');
    }
  }

  if (issues.length) return { checked: true, pass: false, reason: `警語文字${issues.join('、')}` };
  return { checked: true, pass: true, reason: `格式符合規定（${oks.join('、') || '一般樣式'}）` };
}

// Backward-compatible wrapper retaining the old name/signature.
function checkAnnotationFormat(docxStructure, annotationText, fmt, opts) {
  return evaluateRunFormat(docxStructure, annotationText, fmt, opts);
}

// ── Check: fund name annotation (per-fund, arbitrary number of warning items) ─

/**
 * Evaluate one fund_warning_items row against the document for a fund that was
 * found mentioned (as `foundName`).
 *  - require_immediately_after: the warning text must appear right after the
 *    fund name (only ~10 compact chars of slack), and format (bold/colour) is
 *    checked against that located DOCX run.
 *  - otherwise: the text just needs to appear anywhere in the document — fuzzy
 *    match for longer passages (small OCR/typo variance is tolerated), exact
 *    (normalized) match for short ones.
 * Shared by checkFundAnnotation (pass/fail rollup) and getFundAnnotationDetail
 * (per-item breakdown for the result page).
 */
function evaluateFundWarningItem(fwItem, foundName, fullText, pages, docxStructure) {
  const checks = [];
  const issues = [];
  let ok = true;
  let matchedPages = [];
  let fmt = {};
  try { fmt = JSON.parse(fwItem.format_requirements || '{}'); } catch {}
  const text = fwItem.warning_text;

  const mode = fwItem.match_mode || (fwItem.require_immediately_after ? 'after' : 'anywhere');

  // Helper shared by every mode: does the warning text appear anywhere at all?
  const present = text.length > 30 ? fuzzyIncludes(fullText, text, 3) : normalizedIncludes(fullText, text);
  const reportMissing = () => {
    ok = false;
    const phrases = splitIntoPhrases(text, 15);
    const missing = phrases.filter(p => !compactNormalize(fullText).includes(compactNormalize(p)));
    if (phrases.length > 1 && missing.length > 0 && missing.length < phrases.length) {
      issues.push(`「${fwItem.name}」內容不完整，缺少約 ${missing.length}/${phrases.length} 段（例如：「${missing[0].slice(0, 25)}…」）`);
    } else {
      issues.push(`未發現「${fwItem.name}」（應包含：「${text.slice(0, 30)}…」）`);
    }
  };

  if (mode === 'after') {
    const compactFull = compactNormalize(fullText);
    const compactName = compactNormalize(foundName);
    const compactText = compactNormalize(text);
    const nameIdx = compactFull.indexOf(compactName);
    if (nameIdx === -1) {
      ok = false;
      issues.push(`找不到基金名稱「${foundName}」於文中位置，無法核對「${fwItem.name}」`);
    } else {
      const afterName = compactFull.slice(nameIdx + compactName.length, nameIdx + compactName.length + compactText.length + 60);
      const idx = afterName.indexOf(compactText);
      if (idx === -1) {
        ok = false;
        issues.push(`基金名稱「${foundName}」後方未找到「${fwItem.name}」內容「${text.slice(0, 20)}…」`);
      } else if (idx > 10) {
        ok = false;
        issues.push(`「${fwItem.name}」與基金名稱之間有其他文字，應緊接於基金名稱之後`);
      } else {
        matchedPages = findKeywordInPages(pages, [foundName]).map(h => h.page);
        checks.push(`「${fwItem.name}」已緊接於基金名稱「${foundName}」之後`);
      }
    }
  } else if (mode === 'same_page') {
    const namePages = findKeywordInPages(pages, [foundName]).map(h => h.page);
    const textPages = findTextPages(pages, text);
    const overlap = namePages.filter(p => textPages.includes(p));
    if (!present) {
      reportMissing();
    } else if (namePages.length === 0) {
      ok = false;
      issues.push(`找不到基金名稱「${foundName}」所在頁，無法核對「${fwItem.name}」是否與基金名稱同頁`);
    } else if (overlap.length === 0) {
      ok = false;
      matchedPages = textPages;
      issues.push(`「${fwItem.name}」未與基金名稱「${foundName}」出現於同一頁（基金名稱於第 ${namePages.join('、')} 頁，警語於第 ${textPages.join('、') || '?'} 頁）`);
    } else {
      matchedPages = overlap;
      checks.push(`「${fwItem.name}」已與基金名稱「${foundName}」出現於同一頁（第 ${overlap.join('、')} 頁）`);
    }
  } else if (mode === 'document_end') {
    const textPages = findTextPages(pages, text);
    const lastPage = pages.length ? Math.max(...pages.map(p => p.page)) : 0;
    const compactFull = compactNormalize(fullText);
    const tail = compactFull.slice(Math.floor(compactFull.length * 0.75));
    const tailOk = tail.includes(compactNormalize(text).slice(0, 30));
    const atEndPage = textPages.some(p => p >= lastPage); // appears on the final page
    if (!present) {
      reportMissing();
    } else if (!atEndPage && !tailOk) {
      ok = false;
      matchedPages = textPages;
      issues.push(`「${fwItem.name}」未出現在文宣最後（應置於結尾／警語頁；目前出現在第 ${textPages.join('、') || '?'} 頁）`);
    } else {
      matchedPages = textPages.length ? textPages : (lastPage ? [lastPage] : []);
      checks.push(`「${fwItem.name}」已出現於文宣最後` + (matchedPages.length ? `（第 ${matchedPages.join('、')} 頁）` : ''));
    }
  } else { // 'anywhere'
    if (!present) {
      reportMissing();
    } else {
      matchedPages = findTextPages(pages, text);
      checks.push(`「${fwItem.name}」內容已核對相符（共 ${text.length} 字）` + (matchedPages.length ? `，位於第 ${matchedPages.join('、')} 頁` : ''));
    }
  }

  // Format requirements (粗體／底線／不能最小／粗體或顯著顏色／相同大小) — only
  // verifiable against a located DOCX run; PDF/PPTX visual styling needs the
  // separate visual check. referenceSize = the fund name's font size, enabling
  // the 字體相同大小 comparison.
  let format = null;
  if (hasAnyFormatRequirement(fmt)) {
    let referenceSize = null;
    if (docxStructure && docxStructure.paragraphs) {
      const nameLoc = findRunForText(docxStructure, foundName);
      if (!nameLoc.error) referenceSize = nameLoc.run.fontSize;
    }
    const fmtResult = checkAnnotationFormat(docxStructure, text, fmt, { referenceSize });
    if (fmtResult.reason) {
      format = { pass: fmtResult.pass, reason: fmtResult.reason };
      if (fmtResult.pass === false) {
        ok = false;
        issues.push(fmtResult.reason);
      } else if (fmtResult.pass === true) {
        checks.push(fmtResult.reason);
      } else {
        checks.push(`提醒：${fmtResult.reason}`);
      }
    }
  }

  return { ok, checks, issues, format, pages: matchedPages };
}

// ── Structured (non-AI-prompt) applicability / compliance helpers ─────────────
// These back the "適用性判斷=特定文字觸發" / "合規性判斷=包含特定文字警語" modes
// in check-item management, so non-technical admins can configure checks without
// writing AI prompts or JSON parameters.

/**
 * Deterministic applicability check: the item only applies when the document
 * contains at least one of the configured trigger keywords.
 * Returns { applicable, matchedKeyword, reason } — `reason` explains a skip.
 */
function checkApplicabilityKeywords(item, fullText) {
  let keywords = [];
  try { keywords = JSON.parse(item.applicability_keywords || '[]'); } catch {}
  keywords = keywords.filter(Boolean);
  if (keywords.length === 0) return { applicable: true, matchedKeyword: null };
  const hit = keywords.find(kw => normalizedIncludes(fullText, kw));
  if (!hit) {
    return {
      applicable: false,
      matchedKeyword: null,
      reason: `文宣未提及「${keywords.slice(0, 3).join('、')}」${keywords.length > 3 ? '…等' : ''}關鍵字，本項不適用`,
    };
  }
  return { applicable: true, matchedKeyword: hit };
}

/**
 * Checks bold / distinctive-colour / not-smallest-size for the DOCX run containing
 * `text`. Mirrors checkAnnotationFormat but also supports the "not_smallest" rule
 * (compares the run's font size against the document's minimum observed size).
 * Returns { checked, pass, reason } — pass is null when visual confirmation is required.
 */
function checkComplianceFormat(docxStructure, text, fmt) {
  return evaluateRunFormat(docxStructure, text, fmt);
}

/**
 * Deterministic compliance check: the document must contain `item.compliance_text`,
 * optionally anchored to the matched applicability keyword (緊接著／同一頁) and/or
 * meeting format requirements (粗體／顯著顏色／不能是最小字).
 * `anchor` is { keyword } when the applicability phase matched a concrete keyword
 * (i.e. applicability_mode === 'keyword'); null otherwise (e.g. always-applicable
 * or AI-judged applicability, where there's no single anchor point to check position against).
 */
function checkComplianceTextPresence(item, fullText, pages, docxStructure, anchor) {
  const checks = []; const issues = [];
  let fmt = {}; try { fmt = JSON.parse(item.compliance_format || '{}'); } catch {}
  const text = (item.compliance_text || '').trim();
  if (!text) return { pass: null, skipped: true, reason: '尚未設定應包含之警語文字內容，請於檢查項目設定中補充' };
  let ok = true; let matchedPages = [];
  if ((fmt.immediately_after || fmt.same_page) && anchor) {
    if (fmt.immediately_after) {
      const compactFull = compactNormalize(fullText);
      const compactAnchor = compactNormalize(anchor.keyword);
      const compactText = compactNormalize(text);
      const nameIdx = compactFull.indexOf(compactAnchor);
      const after = nameIdx === -1 ? '' : compactFull.slice(nameIdx + compactAnchor.length, nameIdx + compactAnchor.length + compactText.length + 60);
      const idx = after.indexOf(compactText);
      if (nameIdx === -1 || idx === -1 || idx > 10) {
        ok = false;
        issues.push(`觸發內容「${anchor.keyword}」之後未緊接出現應包含之警語文字（應包含：「${text.slice(0, 25)}…」）`);
      } else {
        checks.push(`已確認警語文字緊接於觸發內容「${anchor.keyword}」之後`);
        matchedPages = findTextPages(pages, text);
      }
    } else { // same_page only
      const anchorPages = findKeywordInPages(pages, [anchor.keyword]).map(h => h.page);
      const textPages = findTextPages(pages, text);
      const overlap = anchorPages.filter(p => textPages.includes(p));
      if (anchorPages.length === 0 || overlap.length === 0) {
        ok = false;
        issues.push(`觸發內容「${anchor.keyword}」所在頁未發現應包含之警語文字（應包含：「${text.slice(0, 25)}…」）`);
      } else {
        checks.push(`已確認警語文字與觸發內容「${anchor.keyword}」出現於同一頁（第 ${overlap.join('、')} 頁）`);
        matchedPages = overlap;
      }
    }
  } else {
    if ((fmt.immediately_after || fmt.same_page) && !anchor) {
      checks.push('提醒：「緊接著／同一頁」位置要求僅在「適用性＝特定文字觸發」時可自動核對位置，本次以全文核對警語文字是否出現代替');
    }
    const present = text.length > 30 ? fuzzyIncludes(fullText, text, 3) : normalizedIncludes(fullText, text);
    if (!present) {
      ok = false;
      issues.push(`未發現應包含之警語文字（應包含：「${text.slice(0, 30)}…」）`);
    } else {
      matchedPages = findTextPages(pages, text);
      checks.push(`已發現應包含之警語文字（共 ${text.length} 字）` + (matchedPages.length ? `，位於第 ${matchedPages.join('、')} 頁` : ''));
    }
  }
  if (hasAnyFormatRequirement(fmt)) {
    const fmtResult = checkComplianceFormat(docxStructure, text, fmt);
    if (fmtResult.reason) {
      if (fmtResult.pass === false) { ok = false; issues.push(fmtResult.reason); }
      else if (fmtResult.pass === true) checks.push(fmtResult.reason);
      else checks.push(`提醒：${fmtResult.reason}`);
    }
  }
  if (ok) return { pass: true, reason: checks.join('；'), pages: matchedPages };
  return { pass: false, violation: issues[0], details: issues.join('；'), pages: matchedPages };
}

// ── Fund annotation detail (per-fund / per-item breakdown for result card) ────

function getFundAnnotationDetail(pages, fullText, docxStructure) {
  const db = getDb();
  const fundWarnings = db.prepare('SELECT * FROM fund_warnings WHERE is_active = 1').all();
  const itemsByFund = new Map();
  for (const fw of fundWarnings) {
    itemsByFund.set(fw.id, db.prepare(
      'SELECT * FROM fund_warning_items WHERE fund_id = ? AND is_active = 1 ORDER BY sort_order'
    ).all(fw.id));
  }
  db.close();

  const detail = [];

  for (const fw of fundWarnings) {
    const aliases = JSON.parse(fw.aliases || '[]');
    const allNames = [fw.fund_name, ...aliases].filter(Boolean);

    // Find which name appears in document
    const foundName = allNames.find(n => normalizedIncludes(fullText, n));
    if (!foundName) continue; // fund not mentioned

    const fwItems = itemsByFund.get(fw.id) || [];
    const entry = {
      fund_name: fw.fund_name,
      found_as: foundName,
      pages: findKeywordInPages(pages, [foundName]).map(h => h.page),
      items: [],
    };

    for (const fwItem of fwItems) {
      const r = evaluateFundWarningItem(fwItem, foundName, fullText, pages, docxStructure);
      entry.items.push({
        name: fwItem.name,
        warning_text: fwItem.warning_text,
        match_mode: fwItem.match_mode || (fwItem.require_immediately_after ? 'after' : 'anywhere'),
        ok: r.ok,
        checks: r.checks,
        issues: r.issues,
        format: r.format,
        pages: r.pages || [],
      });
      if (r.pages.length) entry.pages = [...new Set([...entry.pages, ...r.pages])];
    }

    detail.push(entry);
  }

  return detail;
}

function checkFundAnnotation(item, pages, fullText, docxStructure) {
  const detail = getFundAnnotationDetail(pages, fullText, docxStructure);
  const issues = [];
  const checkedFunds = [];

  for (const entry of detail) {
    if (entry.items.length === 0) continue;
    checkedFunds.push(entry.fund_name);
    for (const it of entry.items) {
      if (!it.ok) {
        for (const issueText of it.issues) {
          issues.push({ issue: `基金「${entry.found_as}」：${issueText}`, pages: entry.pages });
        }
      }
    }
  }

  if (issues.length === 0) {
    return {
      pass: true,
      reason: checkedFunds.length > 0
        ? `出現的基金（${checkedFunds.join('、')}）均已正確標示其警語項目`
        : '文宣未提及任何基金名稱，本項不適用',
    };
  }
  return {
    pass: false,
    violation: issues[0].issue,
    details: issues.map(i => i.issue).join('；'),
    pages: [...new Set(issues.flatMap(i => i.pages))],
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function runAutoChecks(checkItems, pages, fullText, docxStructure, options = {}) {
  const results = [];

  for (const item of checkItems) {
    if (item.check_type !== 'auto_keyword') continue;
    if (!item.is_active) continue;

    let result = { check_id: item.id, check_type: item.check_type };
    const params = typeof item.parameters === 'string' ? JSON.parse(item.parameters) : item.parameters;
    const itemWithParsedParams = { ...item, parameters: params };

    try {
      if (item.check_type === 'auto_keyword') {
        const type = params?.type;
        if (type === 'forbidden_keywords') {
          result = { ...result, ...checkForbiddenKeywords(itemWithParsedParams, pages) };
        } else if (type === 'required_text') {
          result = { ...result, ...checkRequiredText(itemWithParsedParams, pages, fullText) };
        } else if (type === 'conditional_required') {
          result = { ...result, ...checkConditionalRequired(itemWithParsedParams, pages, fullText) };
        } else {
          result = { ...result, pass: null, skipped: true, reason: `未知的 auto 類型: ${type}` };
        }
      } else if (item.check_type === 'auto_format') {
        const type = params?.type;
        if (type === 'warning_font_format') {
          result = { ...result, ...checkWarningFontFormat(itemWithParsedParams, docxStructure, []) };
        } else if (type === 'fund_name_annotation') {
          result = { ...result, ...checkFundAnnotation(itemWithParsedParams, pages, fullText, docxStructure) };
        } else {
          result = { ...result, pass: null, skipped: true, reason: `未知的 format 類型: ${type}` };
        }
      }
    } catch (e) {
      result = { ...result, pass: null, error: e.message };
    }

    results.push(result);
  }

  return results;
}

module.exports = {
  runAutoChecks,
  getFundAnnotationDetail,
  checkApplicabilityKeywords,
  checkComplianceFormat,
  checkComplianceTextPresence,
  findKeywordInPages,
  findTextPages,
};
