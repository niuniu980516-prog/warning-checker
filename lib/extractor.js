/**
 * Text & structure extractor
 * - PDF: page-by-page text via pdf-parse
 * - DOCX: paragraph-level text + font size + bold + color via XML
 * - PPTX: slide-level text via XML
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: true,
});

// ── PDF extraction ────────────────────────────────────────────────────────────

async function extractPdfPages(pdfPath) {
  const data = await pdfParse(fs.readFileSync(pdfPath));
  let pageTexts = [];
  await pdfParse(fs.readFileSync(pdfPath), {
    pagerender: (pageData) => {
      return pageData.getTextContent().then((textContent) => {
        const pageText = textContent.items.map(i => i.str).join(' ');
        pageTexts.push(pageText);
        return pageText;
      });
    },
  });
  const pages = pageTexts.map((text, i) => ({ page: i + 1, text, paragraphs: [] }));
  return { pages, fullText: data.text, format: 'pdf' };
}

// ── OCR fallback (image-based PDF) ───────────────────────────────────────────

async function ocrPdfPages(pdfPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  const basename = path.join(tmpDir, 'page');
  const pages = [];

  try {
    // Convert PDF pages to PNG images at 180 DPI
    await execFileAsync('pdftoppm', ['-png', '-r', '180', pdfPath, basename]);

    // Collect generated images (sorted by page number)
    const imageFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)\.png$/)?.[1] || '0');
        const numB = parseInt(b.match(/(\d+)\.png$/)?.[1] || '0');
        return numA - numB;
      });

    if (imageFiles.length === 0) throw new Error('pdftoppm 未產生圖片');

    // Dynamic require so the module is only loaded when actually needed
    const tesseract = require('node-tesseract-ocr');
    const ocrConfig = { lang: 'chi_tra+chi_sim+eng', oem: 1, psm: 3 };

    for (let i = 0; i < imageFiles.length; i++) {
      const imgPath = path.join(tmpDir, imageFiles[i]);
      let text = '';
      try {
        text = await tesseract.recognize(imgPath, ocrConfig);
      } catch (e) {
        console.warn(`OCR page ${i + 1} error:`, e.message);
      }
      pages.push({ page: i + 1, text: text.trim(), paragraphs: [] });
    }
  } finally {
    // Clean up temp images
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const fullText = pages.map(p => p.text).join('\n');
  return { pages, fullText, format: 'pdf', ocr: true };
}

// ── Smart PDF extractor (text layer first, OCR fallback) ─────────────────────

async function extractPdfPagesWithOcrFallback(pdfPath) {
  const result = await extractPdfPages(pdfPath);
  const textLen = result.fullText.replace(/\s/g, '').length;

  if (textLen < 80) {
    console.log(`PDF text too short (${textLen} chars), switching to OCR…`);
    try {
      return await ocrPdfPages(pdfPath);
    } catch (e) {
      console.error('OCR failed:', e.message);
      // Return original (likely empty) result — caller will see short text
    }
  }
  return result;
}

// ── DOCX extraction ───────────────────────────────────────────────────────────

async function extractDocxStructure(docxPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));

  // Extract plain text via mammoth for easy processing
  const mammothResult = await mammoth.extractRawText({ path: docxPath });
  const fullText = mammothResult.value;

  // Parse XML for formatting info
  const docXml = await zip.file('word/document.xml').async('text');
  const parsed = xmlParser.parse(docXml);

  const body = parsed?.['w:document']?.['w:body'] ||
               parsed?.['pkg:package']?.['pkg:part']?.['pkg:xmlData']?.['w:document']?.['w:body'];

  const paragraphs = [];
  const allFontSizes = [];

  function extractRuns(para) {
    const runs = Array.isArray(para?.['w:r']) ? para['w:r'] : (para?.['w:r'] ? [para['w:r']] : []);
    return runs.map(r => {
      const rPr = r?.['w:rPr'] || {};
      const sz = rPr?.['w:sz']?.['@_w:val'] || rPr?.['w:sz']?.['@_val'];
      const szCs = rPr?.['w:szCs']?.['@_w:val'] || rPr?.['w:szCs']?.['@_val'];
      const bold = !!(rPr?.['w:b'] !== undefined && rPr?.['w:b'] !== false);
      const color = rPr?.['w:color']?.['@_w:val'] || rPr?.['w:color']?.['@_val'];
      // Underline: <w:u w:val="single|double|…"/> means underlined; val="none" means not.
      const uNode = rPr?.['w:u'];
      const uVal = uNode === undefined ? undefined
        : (typeof uNode === 'object' ? (uNode?.['@_w:val'] || uNode?.['@_val'] || 'single') : 'single');
      const underline = uVal !== undefined && uVal !== 'none';
      // Collect text
      const tNode = r?.['w:t'];
      const text = typeof tNode === 'string' ? tNode :
                   (typeof tNode === 'object' ? tNode?.['#text'] || '' : '');
      return { text, bold, underline, fontSize: sz ? parseInt(sz) / 2 : null, fontSizeCs: szCs ? parseInt(szCs) / 2 : null, color };
    });
  }

  function processParagraphs(paragraphNodes) {
    if (!paragraphNodes) return;
    const nodes = Array.isArray(paragraphNodes) ? paragraphNodes : [paragraphNodes];
    for (const para of nodes) {
      const runs = extractRuns(para);
      const text = runs.map(r => r.text).join('');
      if (!text.trim()) continue;
      // Track font sizes across all non-empty paragraphs
      for (const r of runs) {
        if (r.fontSize) allFontSizes.push(r.fontSize);
      }
      paragraphs.push({ text, runs });
    }
  }

  if (body) {
    const paraNodes = body?.['w:p'];
    processParagraphs(paraNodes);
    // Handle tables
    const tableNodes = Array.isArray(body?.['w:tbl']) ? body['w:tbl'] : (body?.['w:tbl'] ? [body['w:tbl']] : []);
    for (const tbl of tableNodes) {
      const rows = Array.isArray(tbl?.['w:tr']) ? tbl['w:tr'] : (tbl?.['w:tr'] ? [tbl['w:tr']] : []);
      for (const row of rows) {
        const cells = Array.isArray(row?.['w:tc']) ? row['w:tc'] : (row?.['w:tc'] ? [row['w:tc']] : []);
        for (const cell of cells) {
          processParagraphs(cell?.['w:p']);
        }
      }
    }
  }

  const minFontSize = allFontSizes.length > 0 ? Math.min(...allFontSizes) : null;

  return { paragraphs, fullText, minFontSize, format: 'docx' };
}

// ── PPTX extraction ───────────────────────────────────────────────────────────

async function extractPptxStructure(pptxPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const slides = [];

  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)[1]);
      const numB = parseInt(b.match(/slide(\d+)/)[1]);
      return numA - numB;
    });

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    const parsed = xmlParser.parse(xml);

    function extractText(node) {
      if (typeof node === 'string') return node;
      if (typeof node !== 'object' || node === null) return '';
      if (Array.isArray(node)) return node.map(extractText).join('');
      if ('a:t' in node) {
        const t = node['a:t'];
        return typeof t === 'string' ? t : extractText(t);
      }
      return Object.values(node).map(extractText).join('');
    }

    const text = extractText(parsed);
    slides.push({ page: i + 1, text, paragraphs: [] });
  }

  const fullText = slides.map(s => s.text).join('\n');
  return { pages: slides, fullText, format: 'pptx' };
}

// ── Page image capture (for vision checks) ───────────────────────────────────

async function capturePageImages(pdfPath, maxPages = 20) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
  const basename = path.join(tmpDir, 'pg');
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', '120', '-l', String(maxPages), pdfPath, basename]);
    const imageFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)\.png$/)?.[1] || '0');
        const nb = parseInt(b.match(/(\d+)\.png$/)?.[1] || '0');
        return na - nb;
      });
    return imageFiles.map((f, i) => ({
      page: i + 1,
      data: fs.readFileSync(path.join(tmpDir, f)),
      mimeType: 'image/png',
    }));
  } catch (e) {
    console.warn('capturePageImages error:', e.message);
    return [];
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Main extractor ────────────────────────────────────────────────────────────

async function extract(originalPath, pdfPath, docxPath, pptxPath) {
  const ext = path.extname(originalPath).toLowerCase();
  let result = { pages: [], paragraphs: [], fullText: '', format: ext, images: [] };

  // Always get page-level text from PDF (with OCR fallback for image PDFs)
  if (pdfPath && fs.existsSync(pdfPath)) {
    try {
      const pdfData = await extractPdfPagesWithOcrFallback(pdfPath);
      result.pages = pdfData.pages;
      result.fullText = result.fullText || pdfData.fullText;
      if (pdfData.ocr) result.ocr = true;
    } catch (e) {
      console.warn('PDF extraction error:', e.message);
    }
  }

  // Get DOCX structure (paragraph-level formatting)
  if (docxPath && fs.existsSync(docxPath)) {
    try {
      const docxData = await extractDocxStructure(docxPath);
      result.paragraphs = docxData.paragraphs;
      result.minFontSize = docxData.minFontSize;
      result.fullText = result.fullText || docxData.fullText;
    } catch (e) {
      console.warn('DOCX structure extraction error:', e.message);
    }
  }

  // Get PPTX structure
  if (pptxPath && fs.existsSync(pptxPath)) {
    try {
      const pptxData = await extractPptxStructure(pptxPath);
      if (!result.pages.length) result.pages = pptxData.pages;
      result.fullText = result.fullText || pptxData.fullText;
    } catch (e) {
      console.warn('PPTX structure extraction error:', e.message);
    }
  }

  // If no pages yet, create one page from full text
  if (result.pages.length === 0 && result.fullText) {
    result.pages = [{ page: 1, text: result.fullText, paragraphs: [] }];
  }

  // Capture page images for visual inspection (PDF only, cap 20 pages)
  if (pdfPath && fs.existsSync(pdfPath)) {
    try {
      result.images = await capturePageImages(pdfPath, 20);
    } catch (e) {
      console.warn('Page image capture error:', e.message);
    }
  }

  return result;
}

module.exports = { extract, extractDocxStructure, extractPptxStructure, capturePageImages };
