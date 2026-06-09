/**
 * Generates the 廣告文宣檢查表 result DOCX.
 *
 * The table is built DYNAMICALLY from the current active check_items (one row
 * per 序號 / parent item — never per sub-item), so that whenever the check-item
 * settings are updated, the downloaded checklist reflects them automatically.
 * We reuse the original template's package (styles.xml / fonts / sectPr) but
 * replace the whole <w:body> with freshly generated content, which also drops
 * the template's hard-coded date stamp and per-fund rows.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { getDb } = require('../db/migrate');

const TEMPLATE_PATH = path.join(__dirname, '../data/checklist_template.docx');

// Page content width (twips): pgSz 11906 − left 1800 − right 1800 = 8306
const COL_WIDTHS = { seq: 620, content: 5886, primary: 900, review: 900 }; // sums to 8306

// ── XML helpers ───────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build a paragraph with a single run. sz is in half-points (20 = 10pt).
function para(text, { bold = false, sz = 18, color = null, align = null, font = '標楷體' } = {}) {
  const rPr =
    `<w:rPr>` +
    (font ? `<w:rFonts w:eastAsia="${font}" w:hAnsi="${font}"/>` : '') +
    (bold ? '<w:b/>' : '') +
    (color ? `<w:color w:val="${color}"/>` : '') +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  const pPr = `<w:pPr>${align ? `<w:jc w:val="${align}"/>` : ''}<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr></w:pPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// Build a table cell. content is raw paragraph XML (one or more <w:p>).
function cell(content, { width, gridSpan = 1, fill = null, valign = 'center' } = {}) {
  const tcPr =
    `<w:tcPr>` +
    (width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : '') +
    (gridSpan > 1 ? `<w:gridSpan w:val="${gridSpan}"/>` : '') +
    (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '') +
    `<w:vAlign w:val="${valign}"/></w:tcPr>`;
  return `<w:tc>${tcPr}${content || '<w:p/>'}</w:tc>`;
}

function row(cells) {
  return `<w:tr>${cells.join('')}</w:tr>`;
}

// ── Result rollup (one parent 序號 ← many sub-item results) ────────────────────

// Decide the 初核 symbol for a parent item from its sub-items' results.
// Per requirement, the 初核 column shows ONLY ✗ (any sub-item fails) or N/A
// (nothing applicable / not run); a fully-passing item is left blank. The
// failure reasons stay on the web result page, not in the downloaded checklist.
function rollupSymbol(subResults) {
  const real = subResults.map(r => r && r.result).filter(Boolean);
  const fails = real.filter(r => r.pass === false && !r.skipped);
  const passes = real.filter(r => r.pass === true && !r.skipped);
  if (fails.length > 0) return { symbol: '✗', color: 'CC0000', fill: 'FFF0F0' };
  if (passes.length > 0) return { symbol: '✓', color: '006600', fill: 'F0FFF0' };
  return { symbol: 'N/A', color: '888888', fill: null };                 // skipped / not run
}

// ── Main export ───────────────────────────────────────────────────────────────

async function generateChecklistDocx(checkResult, sessionInfo, outputPath) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const { itemResults, summary } = checkResult;

  // Group sub-item results by their parent check_item id.
  const resultsByParent = new Map();
  for (const r of itemResults) {
    const pid = r.check_item_id;
    if (!pid) continue; // synthetic items (e.g. vision) have no parent — excluded
    if (!resultsByParent.has(pid)) resultsByParent.set(pid, []);
    resultsByParent.get(pid).push(r);
  }

  // Load current active parent check_items (the live definition — so the
  // checklist always matches whatever the admin has configured).
  const db = getDb();
  const parents = db.prepare('SELECT id, category, description, sort_order FROM check_items WHERE is_active = 1 ORDER BY sort_order, id').all();
  db.close();

  // ── Build table rows ────────────────────────────────────────────────────────
  const headerRow = row([
    cell(para('序號', { bold: true, sz: 20, align: 'center' }), { width: COL_WIDTHS.seq, fill: 'D9D9D9' }),
    cell(para('檢查項目內容', { bold: true, sz: 20, align: 'center' }), { width: COL_WIDTHS.content, fill: 'D9D9D9' }),
    cell(para('初核', { bold: true, sz: 20, align: 'center' }), { width: COL_WIDTHS.primary, fill: 'D9D9D9' }),
    cell(para('覆核', { bold: true, sz: 20, align: 'center' }), { width: COL_WIDTHS.review, fill: 'D9D9D9' }),
  ]);

  const bodyRows = [];
  let seq = 0;
  let lastCategory = null;
  for (const parent of parents) {
    if (parent.category && parent.category !== lastCategory) {
      lastCategory = parent.category;
      // Category sub-header spanning all 4 columns
      bodyRows.push(row([
        cell(para(parent.category, { bold: true, sz: 18, color: '1B5FAA' }), { gridSpan: 4, fill: 'EEF3FB' }),
      ]));
    }
    seq += 1;
    const { symbol, color, fill } = rollupSymbol(resultsByParent.get(parent.id) || []);
    const symbolPara = symbol
      ? para(symbol, { bold: true, sz: 22, color, align: 'center' })
      : '<w:p/>';
    bodyRows.push(row([
      cell(para(String(seq), { sz: 18, align: 'center' }), { width: COL_WIDTHS.seq, fill }),
      cell(para(parent.description, { sz: 18 }), { width: COL_WIDTHS.content, fill }),
      cell(symbolPara, { width: COL_WIDTHS.primary, fill }),
      cell('<w:p/>', { width: COL_WIDTHS.review }),
    ]));
  }

  const tblGrid =
    `<w:tblGrid>` +
    `<w:gridCol w:w="${COL_WIDTHS.seq}"/>` +
    `<w:gridCol w:w="${COL_WIDTHS.content}"/>` +
    `<w:gridCol w:w="${COL_WIDTHS.primary}"/>` +
    `<w:gridCol w:w="${COL_WIDTHS.review}"/>` +
    `</w:tblGrid>`;
  const tblPr =
    `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `<w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `<w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>` +
    `</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr>`;
  const table = `<w:tbl>${tblPr}${tblGrid}${headerRow}${bodyRows.join('')}</w:tbl>`;

  // ── Title + metadata block ──────────────────────────────────────────────────
  const date = new Date().toLocaleDateString('zh-TW');
  const filename = sessionInfo.filename || '';
  const username = sessionInfo.username || '';

  const title = para('廣告文宣檢查表', { bold: true, sz: 36, align: 'center' }); // no date stamp (#6)

  // Metadata block — all 10pt (sz=20) per requirement (#9)
  const metaLine1 = para(
    `文宣主題：${filename}　　檢查日期：${date}　　檢核人員：${username}`,
    { bold: true, sz: 20, color: '1B5FAA' }
  );
  const metaLine2 = para(
    `系統檢查結果：共 ${summary.total} 項　✓通過 ${summary.passed} 項　✗不符合 ${summary.failed} 項　N/A ${summary.skipped} 項`,
    { sz: 20 }
  );
  const note = para('（初核欄標示 ✓ 通過／✗ 不符合／N/A 不適用；詳細核對說明與不符合原因請參閱系統線上檢查結果頁面。）', { sz: 16, color: '888888' });

  // ── Assemble body (reuse template package, replace body content) ────────────
  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBytes);
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('Invalid template DOCX');
  let xml = await docXmlFile.async('text');

  // Preserve the original sectPr (page size / margins) from the template
  const sectMatch = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectMatch ? sectMatch[0] : '';

  const body = `<w:body>${title}${metaLine1}${metaLine2}${note}<w:p/>${table}<w:p/>${sectPr}</w:body>`;
  xml = xml.replace(/<w:body>[\s\S]*<\/w:body>/, body);

  zip.file('word/document.xml', xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

module.exports = { generateChecklistDocx };
