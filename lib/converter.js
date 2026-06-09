/**
 * Document converter using LibreOffice
 * Converts DOC/DOCX/PPT/PPTX/PDF → PDF (for page-accurate text extraction)
 * Also converts DOC/PPT → DOCX (for XML analysis)
 */
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const execAsync = promisify(exec);

const SOFFICE = process.env.SOFFICE_PATH || 'soffice';

async function toOutputDir(inputPath, outputDir, format = 'pdf') {
  fs.mkdirSync(outputDir, { recursive: true });
  const cmd = `${SOFFICE} --headless --convert-to ${format} --outdir "${outputDir}" "${inputPath}"`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
  if (process.env.DEBUG) {
    console.log('soffice stdout:', stdout);
    if (stderr) console.log('soffice stderr:', stderr);
  }
  // LibreOffice outputs: <inputFile> -> <outputFile> using filter <Filter>
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${baseName}.${format}`);
  if (!fs.existsSync(outputPath)) {
    throw new Error(`LibreOffice conversion failed: output not found at ${outputPath}`);
  }
  return outputPath;
}

/**
 * Convert any supported format to PDF for page-boundary-accurate text extraction
 */
async function toPdf(inputPath, tmpDir) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.pdf') return inputPath; // already PDF
  return toOutputDir(inputPath, tmpDir, 'pdf');
}

/**
 * Convert DOC/PPT to DOCX/PPTX for XML analysis
 */
async function toDocx(inputPath, tmpDir) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.docx') return inputPath;
  if (ext === '.doc') return toOutputDir(inputPath, tmpDir, 'docx');
  return null; // PPT/PPTX handled separately
}

async function toPptx(inputPath, tmpDir) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.pptx') return inputPath;
  if (ext === '.ppt') return toOutputDir(inputPath, tmpDir, 'pptx');
  return null;
}

module.exports = { toPdf, toDocx, toPptx };
