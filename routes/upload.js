const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/migrate');
const { toPdf, toDocx, toPptx } = require('../lib/converter');
const { extract } = require('../lib/extractor');
const { checkDocument } = require('../lib/checker/index');
const { annotateDocument } = require('../lib/annotator');
const { generateChecklistDocx } = require('../lib/report');
const { AD_TYPES } = require('../lib/ad-types');

const router = express.Router();

const ALLOWED_EXT = ['.doc', '.docx', '.ppt', '.pptx', '.pdf'];
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const OUTPUT_DIR = path.join(__dirname, '../outputs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) return cb(null, true);
    cb(new Error(`不支援的檔案格式：${ext}，請上傳 Word（DOC/DOCX）、PowerPoint（PPT/PPTX）或 PDF`));
  },
});

router.get('/upload', (req, res) => {
  res.render('index', { error: null, adTypes: AD_TYPES });
});

router.post('/upload', upload.single('document'), async (req, res) => {
  if (!req.file) return res.render('index', { error: '請選擇檔案', adTypes: AD_TYPES });

  // Selected ad types (checkbox group `ad_types`). A single checked checkbox
  // posts as a plain string, multiple as an array — normalize to an array and
  // keep only recognised values.
  const rawAdTypes = req.body.ad_types;
  const selectedAdTypes = (Array.isArray(rawAdTypes) ? rawAdTypes : (rawAdTypes ? [rawAdTypes] : []))
    .filter(t => AD_TYPES.includes(t));
  if (selectedAdTypes.length === 0) {
    fs.unlink(req.file.path, () => {});
    return res.render('index', { error: '請至少勾選一項廣告類型', adTypes: AD_TYPES });
  }

  const sessionId = uuidv4();
  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(filePath).toLowerCase();
  const format = ext.slice(1); // 'pdf', 'docx', etc.
  const tmpDir = path.join(OUTPUT_DIR, sessionId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const retentionDays = parseInt(process.env.FILE_RETENTION_DAYS || '30');
  const expiresAt = new Date(Date.now() + retentionDays * 86400000).toISOString();

  // Save session record immediately
  const db = getDb();
  db.prepare(`
    INSERT INTO check_sessions (id, user_id, original_filename, file_path, status, ad_types, expires_at)
    VALUES (?, ?, ?, ?, 'processing', ?, ?)
  `).run(sessionId, req.session.userId, originalName, filePath, JSON.stringify(selectedAdTypes), expiresAt);
  db.close();

  // Return immediately with processing page, run checks in background
  res.redirect(`/results/${sessionId}`);

  // Run checks asynchronously
  processDocument(sessionId, filePath, format, tmpDir, originalName, req.session, selectedAdTypes).catch(err => {
    console.error('Processing error:', err);
    const db2 = getDb();
    db2.prepare("UPDATE check_sessions SET status='failed', error_message=? WHERE id=?")
       .run(err.message, sessionId);
    db2.close();
  });
});

async function processDocument(sessionId, filePath, format, tmpDir, originalName, sessionData, selectedAdTypes = []) {
  let pdfPath = null, docxPath = null, pptxPath = null;

  try {
    // Step 1: Convert to PDF (for page-accurate text extraction)
    pdfPath = await toPdf(filePath, tmpDir);

    // Step 2: Get editable format for annotation
    if (format === 'docx' || format === 'doc') {
      docxPath = await toDocx(filePath, tmpDir);
    } else if (format === 'pptx' || format === 'ppt') {
      pptxPath = await toPptx(filePath, tmpDir);
    }

    // Step 3: Extract text + structure
    const extracted = await extract(filePath, pdfPath, docxPath, pptxPath);
    extracted.format = format;

    // Guard: if text is still empty after OCR fallback, the file is unreadable
    const textLen = (extracted.fullText || '').replace(/\s/g, '').length;
    if (textLen < 30) {
      throw new Error('無法讀取文件內容（文字過短）。如為掃描型 PDF 且 OCR 失敗，請確認 Docker 容器已完成重新建置。');
    }

    // Step 4: Run all checks (filtered to the selected ad types)
    const checkResult = await checkDocument(extracted, { adTypes: selectedAdTypes });

    // Step 5: Generate annotated document
    const annotatedPath = await annotateDocument(filePath, tmpDir, checkResult.itemResults, format, extracted.pages);

    // Step 6: Generate filled checklist
    const checklistPath = path.join(tmpDir, `checklist_${sessionId.slice(0, 8)}.docx`);
    await generateChecklistDocx(checkResult, {
      filename: originalName,
      username: sessionData.username,
    }, checklistPath);

    // Step 7: Update DB
    const db = getDb();
    db.prepare(`
      UPDATE check_sessions SET
        status = 'completed',
        results = ?,
        summary = ?,
        checklist_output_path = ?,
        annotated_output_path = ?,
        ocr_used = ?,
        completed_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(checkResult.itemResults.map(r => ({
        id: r.id, category: r.category, description: r.description,
        result: r.result,
      }))),
      JSON.stringify(checkResult.summary),
      checklistPath,
      annotatedPath,
      extracted.ocr ? 1 : 0,
      sessionId
    );
    db.close();
  } catch (err) {
    throw err;
  }
}

module.exports = router;
