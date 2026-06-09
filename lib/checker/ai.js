/**
 * AI-based checks — every provider (Ollama / Gemini / Claude) evaluates
 * one check item per call (no batching/grouping); each item's systemNote
 * is generated dynamically from its category for prompt framing.
 */
const { getDb } = require('../../db/migrate');
const { getSystemPrompt } = require('../settings');
const { checkApplicabilityKeywords, checkComplianceTextPresence } = require('./auto');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
const USE_OLLAMA    = LLM_PROVIDER === 'ollama';
const USE_GEMINI    = LLM_PROVIDER === 'gemini';
const OLLAMA_BASE   = process.env.OLLAMA_BASE_URL || 'http://ollama:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL  || 'qwen2.5:7b';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || '';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_CONCURRENCY = parseInt(process.env.GEMINI_CONCURRENCY || '4', 10);

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function buildPageSummary(pages) {
  return pages.map(p => `=== 第${p.page}頁 ===\n${p.text}`).join('\n\n').slice(0, 12000);
}

// ── Ollama: one item per call ─────────────────────────────────────────────────

function buildFundRegistryContext() {
  try {
    const db = getDb();
    const funds = db.prepare('SELECT name, inception_date FROM funds WHERE is_active = 1 ORDER BY name').all();
    db.close();
    if (funds.length === 0) return '';
    const today = new Date();
    const lines = funds.map(f => {
      const diffDays = Math.floor((today - new Date(f.inception_date)) / 86400000);
      const years = Math.floor(diffDays / 365);
      const months = Math.floor((diffDays % 365) / 30);
      const ageLabel = years > 0 ? `${years} 年 ${months} 個月` : `${months} 個月`;
      const eligible = years >= 1 ? '（已滿一年，可揭露績效）' : '（未滿一年，不得揭露績效）';
      return `・${f.name}　成立日：${f.inception_date}　目前成立 ${ageLabel} ${eligible}`;
    }).join('\n');
    return `\n\n【基金成立日資料庫】\n請先從文宣內容辨識本文件涉及的基金名稱，再依下列資料判斷該基金是否符合績效揭露資格：\n${lines}`;
  } catch { return ''; }
}

function buildExtraContext(item) {
  const params = typeof item.parameters === 'string'
    ? JSON.parse(item.parameters || '{}') : (item.parameters || {});

  // For fund_name_annotation: inject fund list from DB
  if (params.type === 'fund_name_annotation') {
    try {
      const db = getDb();
      const funds = db.prepare('SELECT * FROM fund_warnings WHERE is_active = 1').all();
      const itemsByFund = new Map();
      for (const f of funds) {
        itemsByFund.set(f.id, db.prepare(
          'SELECT name, warning_text, require_immediately_after, match_mode FROM fund_warning_items WHERE fund_id = ? AND is_active = 1 ORDER BY sort_order'
        ).all(f.id));
      }
      db.close();
      if (funds.length === 0) return '';
      const lines = funds.map(f => {
        const aliases = JSON.parse(f.aliases || '[]');
        const names = [f.fund_name, ...aliases].filter(Boolean).join('、');
        const items = itemsByFund.get(f.id) || [];
        if (items.length === 0) return `・基金：${names} → （無設定警語項目）`;
        const modeLabel = {
          after: '（須緊接基金名稱之後）',
          same_page: '（須出現在基金名稱所在當頁）',
          document_end: '（須出現在文宣最後）',
          anywhere: '',
        };
        const itemLines = items.map(it => {
          const m = it.match_mode || (it.require_immediately_after ? 'after' : 'anywhere');
          return `  - ${it.name}${modeLabel[m] || ''}：${it.warning_text.slice(0, 30)}…`;
        }).join('\n');
        return `・基金：${names}\n${itemLines}`;
      }).join('\n');
      return `\n\n【基金警語資料庫】\n${lines}`;
    } catch { return ''; }
  }

  // For warning_font_format: inject warning text snippets
  if (params.type === 'warning_font_format') {
    try {
      const db = getDb();
      const warnings = db.prepare('SELECT warning_text FROM warning_texts WHERE is_active = 1').all();
      db.close();
      if (warnings.length === 0) return '';
      return `\n\n【合規警語範本（前40字）】\n${warnings.map(w => `・${w.warning_text.slice(0, 40)}`).join('\n')}`;
    } catch { return ''; }
  }

  // For AI warning-presence checks (required_warning_id / placement): clarify where the
  // warning is required to appear, so the AI doesn't wrongly demand it repeat on every
  // page when the rule only requires it to appear once somewhere in the document.
  if (params.required_warning_id || params.placement) {
    let note;
    if (params.placement === 'same_page') {
      note = '此警語規定須出現在「觸發內容所在的同一頁」。請針對文宣中每一次出現觸發情境的頁面，檢查當頁是否有對應警語；若某次觸發的當頁找不到警語，即屬違規（即使警語出現在文件其他頁也不算數）。';
    } else if (params.placement === 'document_end') {
      note = '此警語規定須出現在「文宣最後（結尾／警語頁）」。請檢查文件末段是否有此警語，不需要每頁都出現。';
    } else if (params.placement === 'immediately_after') {
      note = '此警語規定須緊接在相關內容之後（中間不可夾雜其他文字）。';
    } else {
      note = '此警語沒有特別規定出現位置——只要整份文宣中任一處出現過一次即視為已揭露合規，不需要每次出現觸發內容、或每一頁都重複加注。';
    }
    return `\n\n【警語放置位置規定】\n${note}` + buildFundRegistryContext();
  }

  return buildFundRegistryContext();
}

async function checkItemWithOllama(item, pagesSummary) {
  const prompt = buildItemCheckPrompt(item, pagesSummary);

  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 1200 },
    }),
  });

  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = await resp.json();

  const raw = data.response || '';

  // Extract the last JSON object from the response (model reasons first, then outputs JSON)
  const jsonMatches = raw.match(/\{[\s\S]*?\}/g);
  if (!jsonMatches || jsonMatches.length === 0) throw new Error('回傳中找不到 JSON');

  let parsed;
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const candidate = JSON.parse(jsonMatches[i]);
      if (candidate.check_id !== undefined || candidate.pass !== undefined) {
        parsed = candidate;
        break;
      }
    } catch { continue; }
  }
  if (!parsed) throw new Error('回傳 JSON 格式不符');

  return { ...parsed, check_id: item.id };
}

async function runAiChecksWithOllama(aiItems, pages) {
  const pagesSummary = buildPageSummary(pages);
  const results = [];

  for (const item of aiItems) {
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const result = await checkItemWithOllama(item, pagesSummary);
        results.push({ check_type: item.check_type, ...result, check_id: item.id });
        done = true;
      } catch (e) {
        console.warn(`Item ${item.id} attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt === 1) {
          results.push({
            check_id: item.id,
            check_type: item.check_type,
            pass: null,
            skipped: true,
            reason: `請人工確認（AI 無法完成：${e.message}）`,
          });
        }
      }
    }
  }

  return results;
}

// ── Gemini: one item per call (cloud API — safe to run with concurrency) ─────

function extractCheckResultJson(raw, itemId) {
  const jsonMatches = raw.match(/\{[\s\S]*?\}/g);
  if (!jsonMatches || jsonMatches.length === 0) throw new Error('回傳中找不到 JSON');

  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const candidate = JSON.parse(jsonMatches[i]);
      if (candidate.check_id !== undefined || candidate.pass !== undefined) {
        return { ...candidate, check_id: itemId };
      }
    } catch { continue; }
  }
  throw new Error('回傳 JSON 格式不符');
}

function buildItemCheckPrompt(item, pagesSummary) {
  const basePrompt = getSystemPrompt();
  const systemNote = item.category
    ? `${basePrompt}，請依專業判斷評估這份文宣是否符合「${item.category}」相關規範與下列檢查項目要求。`
    : `${basePrompt}。`;
  const extraContext = buildExtraContext(item);

  // If admin has set custom 適用性判斷／合規判斷標準 prompts, build a two-stage task
  // section (applicability first, then compliance criteria). Otherwise fall back to
  // the generic single-field description-based task (backward compatible).
  const hasCustomPrompts = !!(item.applicability_prompt || item.compliance_prompt);
  const taskSection = hasCustomPrompts
    ? `【適用性判斷】
${item.applicability_prompt || '（未設定，視為一律適用）'}

請先依上述條件判斷本檢查項目是否適用於這份文宣。若不適用，直接輸出：
{"check_id":"${item.id}","pass":null,"skipped":true,"reason":"說明為何不適用"}

若適用，請依下列標準評估文宣是否合規：
【合規判斷標準】
${item.compliance_prompt || item.description}`
    : `【合規評估任務】
檢查項目說明：${item.description}`;

  return `${systemNote}

文宣內容：
${pagesSummary}${extraContext}

${taskSection}

請先用自然語言分析文宣是否符合此項要求，說明你的判斷依據，引用文宣中的具體內容（請簡明扼要，不要逐頁列舉，分析控制在 300 字以內）。
分析完畢後，在最後一行輸出 JSON 結果（只輸出一個 JSON 物件）：

若符合：  {"check_id":"${item.id}","pass":true,"reason":"你的分析說明"}
若違規：  {"check_id":"${item.id}","pass":false,"violation":"違規摘要","details":"詳細說明","pages":[頁碼]}
若不適用：{"check_id":"${item.id}","pass":null,"skipped":true,"reason":"不適用原因"}

注意：
- reason/violation/details 必須是你自己的分析，不是模板文字
- 找不到違規就回 pass:true
- pages 填文中 ===第X頁=== 的頁碼數字
- 分析與 JSON 合計請勿超過 600 字，務必確保 JSON 完整輸出、不被截斷`;
}

async function callGemini(parts, { maxOutputTokens = 1500, temperature = 0.2, thinkingBudget = 0 } = {}) {
  if (!GEMINI_API_KEY) throw new Error('未設定 GEMINI_API_KEY');
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        // thinkingBudget defaults to 0 — disabling internal "thinking" tokens, which were
        // silently consuming most of maxOutputTokens (e.g. 1438/1500) and truncating responses
        // before the JSON line was emitted (finishReason: MAX_TOKENS, no JSON found).
        // Callers doing open-ended generation (no JSON deadline) can pass a positive budget
        // to let the model reason first — this measurably improves answer quality/groundedness.
        generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget } },
      }),
    });

    if (resp.status === 429 || resp.status === 503) {
      if (attempt < 3) {
        const wait = 5000 * (attempt + 1);
        console.warn(`Gemini ${resp.status}，${wait}ms 後重試…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}${errText ? '：' + errText.slice(0, 200) : ''}`);
    }

    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') throw new Error('Gemini 因安全政策拒絕回應');
    const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw new Error('Gemini 回應為空');
    return text;
  }
}

async function checkItemWithGemini(item, pagesSummary) {
  const prompt = buildItemCheckPrompt(item, pagesSummary);
  const raw = await callGemini([{ text: prompt }], { maxOutputTokens: 2500, temperature: 0.2 });
  return extractCheckResultJson(raw, item.id);
}

// Generate a suggested 適用性判斷／合規判斷標準 prompt for the admin form's "AI 生成" buttons
async function generateCheckPrompt({ category, description, field }) {
  if (!description) throw new Error('缺少檢查項目描述');

  const prompt = field === 'applicability'
    ? `你是台灣基金廣告合規審查專家。請針對以下檢查項目描述，用一句話（80字以內）寫出「在什麼前提下這個檢查項目才適用於一份廣告文宣」——也就是文宣中需要先出現什麼主題或內容，這個檢查才有意義。若這項規定本來就不需要任何前提、一律適用（例如格式或警語標示規定），就只回答「一律適用」四個字。

只能根據描述字面上提到的主題撰寫，不可以發明描述中完全沒提到的概念或詞彙。

檢查項目描述：${description}

直接輸出這句話本身，不要加引號、不要加「適用性判斷：」之類的標籤：`
    : `你是台灣基金廣告合規審查專家。請針對以下檢查項目描述，用一兩句話（100字以內）具體寫出「應該依據什麼標準判斷文宣是否合規」——例如該包含哪些文字、數值範圍、可接受的來源名單等具體可操作的依據。

只能根據描述字面上的內容撰寫，不可以發明描述中完全沒提到的概念或詞彙，也不要只是重複描述本身。

檢查項目描述：${description}

直接輸出這段標準本身，不要加引號、不要加「合規判斷標準：」之類的標籤：`;

  let raw;
  if (USE_GEMINI) {
    raw = await callGemini([{ text: prompt }], { maxOutputTokens: 1024, temperature: 0.2, thinkingBudget: 512 });
  } else if (USE_OLLAMA) {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.3, num_predict: 250 } }),
    });
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    raw = data.response || '';
  } else {
    const client = getAnthropicClient();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = (msg.content || []).map(c => c.text || '').join('');
  }

  return raw.trim().replace(/^[「『"'\s]+|[」』"'\s]+$/g, '');
}

// Run a worker pool over `items`, calling `handler(item)` with bounded concurrency
async function runWithConcurrency(items, concurrency, handler) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await handler(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function runAiChecksWithGemini(aiItems, pages) {
  const pagesSummary = buildPageSummary(pages);

  return runWithConcurrency(aiItems, GEMINI_CONCURRENCY, async (item) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await checkItemWithGemini(item, pagesSummary);
        return { check_type: item.check_type, ...result, check_id: item.id };
      } catch (e) {
        lastErr = e;
        console.warn(`Item ${item.id} attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
    return {
      check_id: item.id,
      check_type: item.check_type,
      pass: null,
      skipped: true,
      reason: `請人工確認（AI 無法完成：${lastErr.message}）`,
    };
  });
}

// ── Claude: one item per call (cloud API — safe to run with concurrency) ─────

const CLAUDE_CONCURRENCY = parseInt(process.env.CLAUDE_CONCURRENCY || '3', 10);

async function checkItemWithClaude(item, pagesSummary) {
  const client = getAnthropicClient();
  const prompt = buildItemCheckPrompt(item, pagesSummary);
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = (msg.content || []).map(c => c.text || '').join('');
  return extractCheckResultJson(raw, item.id);
}

async function runAiChecksWithClaude(aiItems, pages) {
  const pagesSummary = buildPageSummary(pages);

  return runWithConcurrency(aiItems, CLAUDE_CONCURRENCY, async (item) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await checkItemWithClaude(item, pagesSummary);
        return { check_type: item.check_type, ...result, check_id: item.id };
      } catch (e) {
        lastErr = e;
        console.warn(`Item ${item.id} attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
    return {
      check_id: item.id,
      check_type: item.check_type,
      pass: null,
      skipped: true,
      reason: `請人工確認（AI 無法完成：${lastErr.message}）`,
    };
  });
}

// ── Structured checks (applicability_mode/compliance_mode overlay) ────────────
// Lets non-technical admins configure 適用性判斷／合規性判斷 by picking
// "AI判斷" vs a deterministic rule (特定文字觸發／包含特定文字警語), instead of
// writing AI prompts or JSON parameters. Items that keep both modes at the
// 'ai' default (i.e. all 79 pre-existing items) are untouched — they continue
// through the original buildItemCheckPrompt two-stage flow below.

// Generic provider-agnostic "send a prompt, get raw text back" — factors out
// the Gemini/Ollama/Claude dispatch already used by generateCheckPrompt.
async function callLLMRaw(prompt, { maxTokens = 600 } = {}) {
  if (USE_GEMINI) {
    return callGemini([{ text: prompt }], { maxOutputTokens: Math.max(maxTokens, 512), temperature: 0.2, thinkingBudget: 0 });
  }
  if (USE_OLLAMA) {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.2, num_predict: maxTokens } }),
    });
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    return data.response || '';
  }
  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content || []).map(c => c.text || '').join('');
}

function buildApplicabilityOnlyPrompt(item, pagesSummary) {
  const extraContext = buildExtraContext(item);
  return `${getSystemPrompt()}，請判斷下列檢查項目是否適用於這份文宣。

文宣內容：
${pagesSummary}${extraContext}

【適用性判斷條件】
${item.applicability_prompt || item.description}

請判斷本檢查項目是否適用於這份文宣，只輸出一個 JSON 物件（不要其他文字、不要分析過程）：
{"applicable": true 或 false, "reason": "判斷依據（簡明扼要，50字以內）"}`;
}

function extractApplicabilityJson(raw) {
  const jsonMatches = raw.match(/\{[\s\S]*?\}/g);
  if (!jsonMatches || jsonMatches.length === 0) throw new Error('回傳中找不到 JSON');
  for (let i = jsonMatches.length - 1; i >= 0; i--) {
    try {
      const candidate = JSON.parse(jsonMatches[i]);
      if (typeof candidate.applicable === 'boolean') return candidate;
    } catch { continue; }
  }
  throw new Error('回傳 JSON 格式不符');
}

async function judgeApplicabilityWithAI(item, pagesSummary) {
  const prompt = buildApplicabilityOnlyPrompt(item, pagesSummary);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLLMRaw(prompt, { maxTokens: 300 });
      return extractApplicabilityJson(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn(`Item ${item.id} 適用性判斷失敗，預設為適用以避免漏檢：${lastErr.message}`);
  return { applicable: true, reason: '（AI 適用性判斷失敗，預設為適用）' };
}

function buildComplianceOnlyPrompt(item, pagesSummary, applicabilityNote) {
  const extraContext = buildExtraContext(item);
  const basePrompt = getSystemPrompt();
  const systemNote = item.category
    ? `${basePrompt}，請依專業判斷評估這份文宣是否符合「${item.category}」相關規範與下列檢查項目要求。`
    : `${basePrompt}。`;
  return `${systemNote}

文宣內容：
${pagesSummary}${extraContext}
${applicabilityNote ? `\n（本項已先行確認適用，理由：${applicabilityNote}）\n` : ''}
【合規判斷標準】
${item.compliance_prompt || item.description}

請先用自然語言分析文宣是否符合此項要求，說明你的判斷依據，引用文宣中的具體內容（請簡明扼要，控制在 200 字以內）。
分析完畢後，在最後一行輸出 JSON 結果（只輸出一個 JSON 物件）：

若符合：  {"check_id":"${item.id}","pass":true,"reason":"你的分析說明"}
若違規：  {"check_id":"${item.id}","pass":false,"violation":"違規摘要","details":"詳細說明","pages":[頁碼]}

注意：
- reason/violation/details 必須是你自己的分析，不是模板文字
- pages 填文中 ===第X頁=== 的頁碼數字
- 分析與 JSON 合計請勿超過 500 字，務必確保 JSON 完整輸出、不被截斷`;
}

// One structured item = up to two phases: applicability (keyword rule or AI judgment),
// then compliance (deterministic text-presence rule or AI judgment). `anchor` carries
// the matched keyword from a 'keyword'-mode applicability phase through to compliance,
// so 緊接著／同一頁 position checks have a concrete point of reference.
async function evaluateStructuredAiItem(item, pagesSummary, ctx) {
  const { pages, fullText, docxStructure } = ctx;
  let anchor = null;

  if (item.applicability_mode === 'always') {
    // Always applicable — skip applicability judgment entirely, proceed to compliance
  } else if (item.applicability_mode === 'keyword') {
    const r = checkApplicabilityKeywords(item, fullText);
    if (!r.applicable) {
      return { check_id: item.id, check_type: item.check_type, pass: null, skipped: true, reason: r.reason };
    }
    if (r.matchedKeyword) anchor = { keyword: r.matchedKeyword };
  } else if (item.applicability_mode === 'ai') {
    const r = await judgeApplicabilityWithAI(item, pagesSummary);
    if (!r.applicable) {
      return { check_id: item.id, check_type: item.check_type, pass: null, skipped: true, reason: r.reason || '本項不適用於這份文宣' };
    }
  }

  if (item.compliance_mode === 'text_presence') {
    const r = checkComplianceTextPresence(item, fullText, pages, docxStructure, anchor);
    return { check_id: item.id, check_type: item.check_type, ...r };
  }

  const applicabilityNote = anchor ? `已於文宣中發現關鍵內容「${anchor.keyword}」` : null;
  const prompt = buildComplianceOnlyPrompt(item, pagesSummary, applicabilityNote);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLLMRaw(prompt, { maxTokens: 1200 });
      const result = extractCheckResultJson(raw, item.id);
      return { check_type: item.check_type, ...result, check_id: item.id };
    } catch (e) {
      lastErr = e;
      console.warn(`Item ${item.id} attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  return { check_id: item.id, check_type: item.check_type, pass: null, skipped: true, reason: `請人工確認（AI 無法完成：${lastErr.message}）` };
}

async function runStructuredAiChecks(items, pages, fullText, docxStructure) {
  if (items.length === 0) return [];
  const pagesSummary = buildPageSummary(pages);
  const concurrency = USE_GEMINI ? GEMINI_CONCURRENCY : (USE_OLLAMA ? 1 : CLAUDE_CONCURRENCY);
  return runWithConcurrency(items, concurrency, (item) =>
    evaluateStructuredAiItem(item, pagesSummary, { pages, fullText, docxStructure })
  );
}

// ── Main AI runner ────────────────────────────────────────────────────────────

async function runAiChecks(allCheckItems, pages, fullText, docxStructure) {
  const aiItems = allCheckItems.filter(item => (item.check_type === 'ai' || item.check_type === 'auto_format') && item.is_active);

  // Items configured with a structured (non-'ai') applicability or compliance mode
  // bypass the prompt-based flow entirely — they're evaluated deterministically (or
  // with a narrowly-scoped AI call) via evaluateStructuredAiItem. All pre-existing
  // items default both modes to 'ai' and fall through to the original flow untouched.
  const structuredItems = aiItems.filter(item => item.applicability_mode === 'keyword' || item.applicability_mode === 'always' || item.compliance_mode === 'text_presence');
  const plainItems = aiItems.filter(item => !structuredItems.includes(item));

  const structuredPromise = runStructuredAiChecks(structuredItems, pages, fullText, docxStructure);

  let plainPromise;
  if (USE_OLLAMA) {
    plainPromise = runAiChecksWithOllama(plainItems, pages);
  } else if (USE_GEMINI) {
    if (!GEMINI_API_KEY) {
      plainPromise = Promise.resolve(plainItems.map(item => ({
        check_id: item.id,
        check_type: item.check_type,
        pass: null,
        skipped: true,
        reason: '未設定 GEMINI_API_KEY，跳過 AI 檢查',
      })));
    } else {
      plainPromise = runAiChecksWithGemini(plainItems, pages);
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    plainPromise = Promise.resolve(plainItems.map(item => ({
      check_id: item.id,
      check_type: 'ai',
      pass: null,
      skipped: true,
      reason: '未設定 ANTHROPIC_API_KEY，跳過 AI 檢查',
    })));
  } else {
    plainPromise = runAiChecksWithClaude(plainItems, pages);
  }

  const [structuredResults, plainResults] = await Promise.all([structuredPromise, plainPromise]);
  return [...structuredResults, ...plainResults];
}

// ── Multimodal text extraction from page images ──────────────────────────────
// Plain OCR (tesseract) frequently mis-reads stylised marketing text embedded in
// photos/graphics (decorative fonts, low contrast, text on busy backgrounds).
// When a page contains images, we ask the vision-capable model to transcribe
// every piece of visible text — including text inside images/charts — so that
// downstream fund-warning / required-text / keyword checks (which all match
// against `fullText`/`pages[].text`) can find content that lives inside images,
// not just the page's native text layer.

function buildTranscriptionPrompt() {
  return `請仔細閱讀這張廣告文宣頁面圖片，將畫面中「所有看得到的文字」逐字轉錄輸出——包含標題、內文、警語、圖片/圖表/標籤中以圖像形式呈現的文字、小字註記等，無論字體大小或樣式。

請依照畫面中由上到下、由左到右的閱讀順序輸出純文字內容，不要加上任何說明、分析或前言，也不要省略或摘要任何文字。若畫面中完全沒有文字，請只輸出「（無文字）」。`;
}

async function transcribeImageGemini(img) {
  const raw = await callGemini([
    { text: buildTranscriptionPrompt() },
    { inlineData: { mimeType: img.mimeType || 'image/png', data: img.data.toString('base64') } },
  ], { maxOutputTokens: 2048, temperature: 0 });
  return raw.trim();
}

async function transcribeImageClaude(img) {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data.toString('base64') } },
        { type: 'text', text: buildTranscriptionPrompt() },
      ],
    }],
  });
  return (response.content.find(c => c.type === 'text')?.text || '').trim();
}

async function transcribeImageOllama(img) {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_VISION_MODEL,
      prompt: buildTranscriptionPrompt(),
      images: [img.data.toString('base64')],
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!resp.ok) throw new Error(`Ollama vision HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.response || '').trim();
}

/**
 * Transcribe all visible text (including text embedded in images/graphics) for
 * each page image via a multimodal model. Returns [{ page, text }], skipping
 * pages where transcription fails or finds nothing. Caller merges this into
 * `pages[].text`/`fullText` so text-presence checks can see in-image content.
 */
async function transcribeImagesText(imageBuffers) {
  if (!imageBuffers || imageBuffers.length === 0) return [];

  const canUseGemini = USE_GEMINI && !!GEMINI_API_KEY;
  const canUseOllama = USE_OLLAMA && OLLAMA_VISION_MODEL;
  const canUseClaude = !USE_OLLAMA && !USE_GEMINI && !!process.env.ANTHROPIC_API_KEY;
  if (!canUseGemini && !canUseOllama && !canUseClaude) return [];

  const transcribeOne = canUseGemini ? transcribeImageGemini
    : canUseOllama ? transcribeImageOllama
    : transcribeImageClaude;

  const concurrency = canUseGemini ? GEMINI_CONCURRENCY : (canUseOllama ? 1 : CLAUDE_CONCURRENCY);
  const results = await runWithConcurrency(imageBuffers, concurrency, async (img) => {
    try {
      const text = await transcribeOne(img);
      if (!text || text.includes('（無文字）') || text.includes('(無文字)')) return null;
      return { page: img.page, text };
    } catch (e) {
      console.warn(`Image text transcription page ${img.page} error:`, e.message);
      return null;
    }
  });

  return results.filter(Boolean);
}

// ── Vision checks ─────────────────────────────────────────────────────────────

function buildVisionPrompt() {
  return `${getSystemPrompt()}，請仔細檢查這張廣告圖片：

1. 【警語字體大小】廣告中是否有警語文字（如「投資一定有風險」、「申購前應詳閱」等）？若有，請比較它與畫面中「所有文字」的大小——只要不是整張廣告裡最小的字體即合規，不需要跟主要廣告標題／訴求文字一樣大（警語本來就常常比主標題小，這是正常的，不算違規）。顏色不限（灰色等均可）。只有當警語字體明顯是全圖最小字體時，才屬違規。
2. 【警語粗體】警語文字是否以粗體標示（必要）？若非粗體為違規。
3. 【警語位置】警語是否在廣告明顯位置？是否被遮蔽或過於邊緣？
4. 【違規用語】是否有「保本」「穩賺」「保證獲利」「打敗通膨」「政府保證」等違規字眼？
5. 【基金加注】若出現基金名稱，後方是否有風險等級加注（如 RR3、RR4）？

請用繁體中文逐項回答。若全部合規請說「此頁廣告文宣合規，無違規事項」。
直接從第1項開始作答，不要加上「好的，我將...」之類的開場白或客套話。`;
}

// Some models prefix their analysis with a conversational preamble
// ("好的，我將根據台灣基金廣告合規規範，逐項審查這張廣告圖片：") despite being told
// not to — strip a leading line like that so check results show only the findings.
function stripAiPreamble(text) {
  const lines = text.split('\n');
  if (lines.length > 1) {
    const first = lines[0].trim();
    const looksConversational = /^(好的|了解|收到|沒問題|當然|以下)[，,：:]/.test(first)
      || (/我(將|會|現在|來)/.test(first) && /(審查|檢視|分析|評估|檢查|逐項|逐一)/.test(first));
    if (looksConversational && /[:：]\s*$/.test(first)) lines.shift();
  }
  return lines.join('\n').trim();
}

async function runVisionCheckGemini(img) {
  const raw = await callGemini([
    { text: buildVisionPrompt() },
    { inlineData: { mimeType: img.mimeType || 'image/png', data: img.data.toString('base64') } },
  ], { maxOutputTokens: 1024, temperature: 0.1 });
  return stripAiPreamble(raw);
}

async function runVisionChecksWithGemini(imageBuffers) {
  return runWithConcurrency(imageBuffers, GEMINI_CONCURRENCY, async (img) => {
    try {
      const text = await runVisionCheckGemini(img);
      const isViolation = !text.includes('合規') && !text.includes('無違規') && text.length > 20;
      return {
        check_id: `vision_p${img.page}`,
        check_type: 'ai_vision',
        page: img.page,
        pass: !isViolation,
        ...(isViolation
          ? { violation: `第${img.page}頁視覺格式疑慮`, details: text, pages: [img.page] }
          : { reason: text.slice(0, 200) }),
      };
    } catch (e) {
      console.warn(`Vision page ${img.page} error:`, e.message);
      return {
        check_id: `vision_p${img.page}`,
        check_type: 'ai_vision',
        page: img.page,
        pass: null,
        skipped: true,
        reason: `視覺模型呼叫失敗：${e.message}`,
      };
    }
  });
}

async function runVisionCheckOllama(img) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000); // 3-min timeout per page
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL,
        prompt: buildVisionPrompt(),
        images: [img.data.toString('base64')],
        stream: false,
        options: { temperature: 0.1 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama vision HTTP ${resp.status}`);
    const data = await resp.json();
    return stripAiPreamble(data.response || '');
  } finally {
    clearTimeout(timer);
  }
}

async function runVisionCheckClaude(batch) {
  const client = getAnthropicClient();
  const imageContent = batch.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data.toString('base64') },
  }));
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: buildVisionPrompt() }] }],
  });
  return stripAiPreamble(response.content.find(c => c.type === 'text')?.text || '');
}

async function runVisionChecks(imageBuffers) {
  if (!imageBuffers || imageBuffers.length === 0) return [];

  if (USE_GEMINI) {
    if (!GEMINI_API_KEY) {
      console.log('Vision checks skipped: GEMINI_API_KEY not set');
      return [];
    }
    return runVisionChecksWithGemini(imageBuffers);
  }

  const canUseOllama = USE_OLLAMA && OLLAMA_VISION_MODEL;
  const canUseClaude = !USE_OLLAMA && !!process.env.ANTHROPIC_API_KEY;
  if (!canUseOllama && !canUseClaude) {
    console.log('Vision checks skipped: no vision provider configured');
    return [];
  }

  const results = [];

  if (canUseOllama) {
    for (const img of imageBuffers) {
      try {
        const text = await runVisionCheckOllama(img);
        const isViolation = !text.includes('合規') && !text.includes('無違規') && text.length > 20;
        results.push({
          check_id: `vision_p${img.page}`,
          check_type: 'ai_vision',
          page: img.page,
          pass: !isViolation,
          ...(isViolation
            ? { violation: `第${img.page}頁視覺格式疑慮`, details: text, pages: [img.page] }
            : { reason: text.slice(0, 120) }),
        });
      } catch (e) {
        const isTimeout = e.name === 'AbortError' || e.message.includes('abort');
        console.warn(`Vision page ${img.page} error:`, e.message);
        results.push({
          check_id: `vision_p${img.page}`,
          check_type: 'ai_vision',
          page: img.page,
          pass: null,
          skipped: true,
          reason: isTimeout
            ? `視覺模型逾時（CPU 運算過慢，請人工確認第${img.page}頁警語格式）`
            : `視覺模型呼叫失敗：${e.message}`,
        });
      }
    }
  } else {
    for (let i = 0; i < imageBuffers.length; i += 5) {
      const batch = imageBuffers.slice(i, i + 5);
      try {
        const text = await runVisionCheckClaude(batch);
        const isViolation = !text.includes('無問題') && !text.includes('合規');
        if (isViolation) {
          results.push({
            check_id: `vision_batch_${i}`,
            check_type: 'ai_vision',
            pass: false,
            violation: '圖片視覺格式疑慮',
            details: text,
            pages: batch.map(img => img.page),
          });
        }
      } catch (e) {
        console.warn('Claude vision batch error:', e.message);
      }
    }
  }

  return results;
}

module.exports = { runAiChecks, runVisionChecks, generateCheckPrompt, transcribeImagesText };
