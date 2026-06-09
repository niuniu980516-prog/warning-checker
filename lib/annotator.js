/**
 * Annotates original document with violation notes
 * DOCX: inserts red highlighted paragraph before/after violating section
 * PDF: adds red text box overlay on violating pages
 * PPTX: inserts red text box on violating slides
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { normalize } = require('./normalizer');

// ── DOCX annotator ────────────────────────────────────────────────────────────

async function annotateDocx(docxPath, violations, outputPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('Invalid DOCX: no document.xml');

  let docXml = await docXmlFile.async('text');

  // Build violation summary blocks — insert as XML paragraphs at doc start
  const violationParas = violations.map((v, idx) => buildViolationParagraph(idx + 1, v)).join('\n');

  // Insert after <w:body> opening tag
  docXml = docXml.replace('<w:body>', `<w:body>${buildSummarySection(violations)}${violationParas}`);

  // Also insert inline annotations near matching text
  for (const v of violations) {
    if (v.details) {
      docXml = insertInlineAnnotation(docXml, v);
    }
  }

  zip.file('word/document.xml', docXml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

function buildViolationParagraph(num, v) {
  const header = `【違規${num}】${v.category} ▸ ${v.violation}`;
  let xml = `<w:p>
    <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="CC2222"/></w:pPr>
    <w:r>
      <w:rPr><w:b/><w:color w:val="FFFFFF"/><w:shd w:val="clear" w:color="auto" w:fill="CC2222"/></w:rPr>
      <w:t xml:space="preserve">${escapeXml(header)}</w:t>
    </w:r>
  </w:p>`;
  if (v.details && v.details !== v.violation) {
    xml += `<w:p>
      <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="FFE8E8"/><w:ind w:left="240"/></w:pPr>
      <w:r>
        <w:rPr><w:color w:val="880000"/><w:sz w:val="16"/></w:rPr>
        <w:t xml:space="preserve">${escapeXml(v.details)}</w:t>
      </w:r>
    </w:p>`;
  }
  if (v.pages && v.pages.length > 0) {
    xml += `<w:p>
      <w:pPr><w:ind w:left="240"/></w:pPr>
      <w:r>
        <w:rPr><w:color w:val="888888"/><w:sz w:val="16"/></w:rPr>
        <w:t xml:space="preserve">▸ 位置：第${escapeXml(v.pages.join('、'))}頁</w:t>
      </w:r>
    </w:p>`;
  }
  return xml;
}

function buildSummarySection(violations) {
  if (violations.length === 0) return '';
  const header = `【文宣合規檢查結果】共發現 ${violations.length} 項不符合事項`;
  return `<w:p>
    <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="CC0000"/></w:pPr>
    <w:r>
      <w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="28"/></w:rPr>
      <w:t>${escapeXml(header)}</w:t>
    </w:r>
  </w:p>`;
}

function insertInlineAnnotation(docXml, violation) {
  if (!violation.matchedText) return docXml;
  const escaped = escapeXml(violation.matchedText.slice(0, 20));
  const annotation = `<w:p>
    <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="FFAAAA"/></w:pPr>
    <w:r>
      <w:rPr><w:b/><w:color w:val="990000"/></w:rPr>
      <w:t xml:space="preserve">⚠ ${escapeXml(violation.violation)}</w:t>
    </w:r>
  </w:p>`;

  // Find the run containing the matched text and insert annotation after its paragraph
  const paraEndRegex = new RegExp(`(<w:t[^>]*>${escaped}[^<]*</w:t>[^]*?</w:p>)`, 'm');
  return docXml.replace(paraEndRegex, `$1${annotation}`);
}

// ── PDF annotator ─────────────────────────────────────────────────────────────

// CJK font path in Docker container
const CJK_FONT_PATH = process.env.CJK_FONT_PATH || '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';

async function loadCjkFont(pdfDoc) {
  try {
    if (fs.existsSync(CJK_FONT_PATH)) {
      const fontBytes = fs.readFileSync(CJK_FONT_PATH);
      return await pdfDoc.embedFont(fontBytes, { subset: false });
    }
  } catch {}
  // Fallback to Helvetica (Latin only)
  return await pdfDoc.embedFont(StandardFonts.Helvetica);
}

// Safe text: replace CJK chars with [?] if font is Helvetica only
function safeText(text, font, maxLen = 80) {
  const t = String(text || '').slice(0, maxLen);
  if (font.name && font.name.includes('Helvetica')) {
    return t.replace(/[　-鿿豈-﫿＀-￯]/g, '?');
  }
  return t;
}

async function annotatePdf(pdfPath, violations, outputPath) {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Load CJK font once
  const cjkFont = await loadCjkFont(pdfDoc);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Group violations by page
  const byPage = {};
  for (const v of violations) {
    const pages = v.pages && v.pages.length > 0 ? v.pages : [1];
    for (const p of pages) {
      if (!byPage[p]) byPage[p] = [];
      byPage[p].push(v);
    }
  }

  // Add summary page at beginning
  const summaryPage = pdfDoc.insertPage(0);
  await drawSummaryPage(pdfDoc, summaryPage, violations, cjkFont, boldFont);

  // Add annotation boxes on violating pages (offset +1 due to inserted summary page)
  for (const [pageNum, pageViolations] of Object.entries(byPage)) {
    const pageIdx = parseInt(pageNum); // 1-based original → index after summary insert
    if (pageIdx < pdfDoc.getPageCount()) {
      const page = pdfDoc.getPage(pageIdx);
      drawViolationBox(page, pageViolations, cjkFont);
    }
  }

  const annotatedBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, annotatedBytes);
  return outputPath;
}

async function drawSummaryPage(pdfDoc, page, violations, cjkFont, boldFont) {
  const { width, height } = page.getSize();
  page.setSize(595, 842); // A4

  // Background
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.97, 0.97, 0.97) });

  // Header bar
  page.drawRectangle({ x: 0, y: 800, width: 595, height: 42, color: rgb(0.106, 0.373, 0.667) });

  page.drawText('Compliance Check Report', {
    x: 20, y: 812, size: 16, font: boldFont, color: rgb(1, 1, 1),
  });

  page.drawText(`Violations found: ${violations.length}`, {
    x: 20, y: 780, size: 12, font: boldFont,
    color: violations.length > 0 ? rgb(0.8, 0, 0) : rgb(0, 0.5, 0),
  });

  let y = 755;
  for (let i = 0; i < violations.length && y > 40; i++) {
    const v = violations[i];
    const pageRef = v.pages && v.pages.length > 0 ? ` [第${v.pages.join(',')}頁]` : '';

    // Violation header line
    page.drawText(`${i + 1}.`, { x: 20, y, size: 9, font: boldFont, color: rgb(0.6, 0, 0) });
    const violLine = safeText(`${v.category}: ${v.violation}${pageRef}`, cjkFont, 90);
    try {
      page.drawText(violLine, { x: 36, y, size: 8, font: cjkFont, color: rgb(0.15, 0.15, 0.15) });
    } catch {
      page.drawText(violLine.replace(/[^\x00-\x7F]/g, '?'), { x: 36, y, size: 8, font: boldFont, color: rgb(0.15, 0.15, 0.15) });
    }
    y -= 13;

    // Details line (AI reasoning)
    if (v.details && v.details !== v.violation && y > 40) {
      const detailLine = safeText(v.details, cjkFont, 100);
      try {
        page.drawText(detailLine, { x: 36, y, size: 7, font: cjkFont, color: rgb(0.4, 0.1, 0.1) });
      } catch {
        page.drawText(detailLine.replace(/[^\x00-\x7F]/g, '?'), { x: 36, y, size: 7, font: boldFont, color: rgb(0.4, 0.1, 0.1) });
      }
      y -= 12;
    }
    y -= 4;
  }
}

function drawViolationBox(page, violations, cjkFont) {
  const { width, height } = page.getSize();
  const font = cjkFont;

  const lineCount = violations.reduce((n, v) => n + wrapText(safeText(v.violation, font, 80), 70).length, 0);
  const boxHeight = Math.min(28 + lineCount * 13, 110);

  // Red semi-transparent box at top
  page.drawRectangle({
    x: 8, y: height - boxHeight - 8,
    width: width - 16, height: boxHeight,
    color: rgb(0.85, 0.1, 0.1),
    opacity: 0.88,
  });

  let y = height - 22;
  for (let i = 0; i < violations.length && y > height - boxHeight - 4; i++) {
    const v = violations[i];
    const label = `${i + 1}. ${safeText(v.violation || v.category, font, 75)}`;
    try {
      page.drawText(label, { x: 14, y, size: 7, font, color: rgb(1, 1, 0.9) });
    } catch {
      page.drawText(label.replace(/[^\x00-\x7F]/g, '?'), { x: 14, y, size: 7, font, color: rgb(1, 1, 0.9) });
    }
    y -= 13;
  }
}

// ── PPTX annotator ────────────────────────────────────────────────────────────

async function annotatePptx(pptxPath, violations, outputPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));

  const byPage = {};
  for (const v of violations) {
    const slides = v.pages && v.pages.length > 0 ? v.pages : [];
    for (const p of slides) {
      if (!byPage[p]) byPage[p] = [];
      byPage[p].push(v);
    }
  }

  for (const [slideNum, slideViolations] of Object.entries(byPage)) {
    const slideFile = `ppt/slides/slide${slideNum}.xml`;
    if (!zip.file(slideFile)) continue;

    let slideXml = await zip.file(slideFile).async('text');
    const textBox = buildPptxViolationBox(slideViolations);
    // Insert text box before </p:sp> of last shape or at end of spTree
    slideXml = slideXml.replace('</p:spTree>', `${textBox}</p:spTree>`);
    zip.file(slideFile, slideXml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

function buildPptxViolationBox(violations) {
  const text = violations.map((v, i) => `${i + 1}. ${v.violation || v.category}`).join(' | ');
  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="9001" name="ViolationNote"/>
      <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
      <p:nvPr/>
    </p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="685800"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="CC0000"/></a:solidFill>
    </p:spPr>
    <p:txBody>
      <a:bodyPr/>
      <a:lstStyle/>
      <a:p><a:r>
        <a:rPr lang="zh-TW" b="1" sz="1000">
          <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
        </a:rPr>
        <a:t>${escapeXml(text.slice(0, 200))}</a:t>
      </a:r></a:p>
    </p:txBody>
  </p:sp>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxLen) {
  const lines = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (current.length >= maxLen) { lines.push(current); current = ''; }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Page finder: locate which page a violation keyword appears on ─────────────

function findViolationPages(violation, extractedPages) {
  if (!extractedPages || extractedPages.length === 0) return [];

  const candidates = [];

  // 1. Extract quoted content from details (e.g. 第2頁「保本」) — most reliable
  const combined = [violation.details, violation.violation].filter(Boolean).join(' ');
  const quotedMatches = combined.match(/[「『"]([\s\S]{2,30})[」』"]/g) || [];
  candidates.push(...quotedMatches.map(q => q.replace(/[「『"」』"]/g, '').trim()));

  // 2. Extract CJK phrases of 3+ chars from violation text
  const violPhrases = (violation.violation || '').match(/[一-鿿]{3,10}/g) || [];
  candidates.push(...violPhrases);

  // 3. Extract significant nouns from description
  const descPhrases = (violation.description || '').match(/[一-鿿]{4,12}/g) || [];
  candidates.push(...descPhrases.slice(0, 2));

  for (const term of candidates) {
    if (!term || term.length < 2) continue;
    const hits = extractedPages
      .filter(pg => (pg.text || '').replace(/\s+/g, '').includes(term.replace(/\s+/g, '')))
      .map(pg => pg.page);
    // Only use if it narrows down pages (not found on every page)
    if (hits.length > 0 && hits.length <= Math.ceil(extractedPages.length * 0.6)) {
      return hits;
    }
  }
  return [];
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function annotateDocument(originalPath, outputDir, checkResults, format, extractedPages) {
  const violations = checkResults.filter(r => r.result && r.result.pass === false).map(r => {
    let pages = r.result.pages || [];
    // If AI didn't return page numbers, try to find them from extracted page text
    if (pages.length === 0 && extractedPages) {
      pages = findViolationPages({
        violation: r.result.violation,
        details: r.result.details,
        description: r.description,
      }, extractedPages);
    }
    return {
      category: r.category,
      description: r.description,
      violation: r.result.violation || '',
      details: r.result.details || '',
      pages,
      matchedText: r.result.matchedText,
    };
  });

  if (violations.length === 0) {
    // No violations: copy original file
    const outputPath = path.join(outputDir, 'annotated_' + path.basename(originalPath));
    fs.copyFileSync(originalPath, outputPath);
    return outputPath;
  }

  const baseName = path.basename(originalPath, path.extname(originalPath));
  const outputPath = path.join(outputDir, `annotated_${baseName}${path.extname(originalPath)}`);

  try {
    if (format === 'pdf') {
      await annotatePdf(originalPath, violations, outputPath);
    } else if (format === 'docx' || format === 'doc') {
      const docxSource = format === 'docx' ? originalPath :
                         path.join(outputDir, baseName + '.docx');
      await annotateDocx(docxSource, violations, outputPath);
    } else if (format === 'pptx' || format === 'ppt') {
      const pptxSource = format === 'pptx' ? originalPath :
                         path.join(outputDir, baseName + '.pptx');
      await annotatePptx(pptxSource, violations, outputPath);
    } else {
      fs.copyFileSync(originalPath, outputPath);
    }
  } catch (e) {
    console.error('Annotation error:', e.message);
    // Fall back to copy original
    fs.copyFileSync(originalPath, outputPath);
  }

  return outputPath;
}

module.exports = { annotateDocument };
