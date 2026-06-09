/**
 * Text normalization utilities
 * Handles full-width/half-width, whitespace, line breaks for fuzzy matching
 */

const FULLWIDTH_TO_HALF = Object.fromEntries(
  Array.from({ length: 94 }, (_, i) => [
    String.fromCharCode(0xFF01 + i),
    String.fromCharCode(0x21 + i),
  ])
);
FULLWIDTH_TO_HALF['　'] = ' '; // ideographic space

function toHalfWidth(str) {
  return str.replace(/[！-～　]/g, c => FULLWIDTH_TO_HALF[c] || c);
}

function normalize(text) {
  if (!text) return '';
  return toHalfWidth(text)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compact normalization: strip ALL whitespace.
 * Used for warning/fund text matching where PDF extraction may insert
 * spaces between every character, or line breaks may differ.
 */
function compactNormalize(text) {
  return normalize(text).replace(/\s/g, '');
}

/**
 * Check if haystack contains needle after normalization.
 * Ignores full/half-width differences, whitespace, line breaks.
 * Uses compact (whitespace-stripped) comparison so PDF spacing artifacts
 * don't cause false negatives.
 */
function normalizedIncludes(haystack, needle) {
  if (!needle) return true;
  return compactNormalize(haystack).includes(compactNormalize(needle));
}

/**
 * Fuzzy includes: allows up to `tolerance` character differences per 20-char window.
 * Used for warning text matching where minor punctuation may differ.
 */
function fuzzyIncludes(haystack, needle, tolerance = 2) {
  // Compare on whitespace-stripped text — PDF/PPTX extraction frequently inserts
  // spaces between every glyph (e.g. "投 資 一 定"), and line breaks can fall at
  // arbitrary points mid-phrase. Stripping whitespace before the tolerance-based
  // comparison avoids false negatives from these layout artifacts while the
  // per-character diff count still catches genuine punctuation/wording differences.
  const h = compactNormalize(haystack);
  const n = compactNormalize(needle);
  if (n.length === 0) return true;
  if (h.includes(n)) return true;

  // Slide window approach for short needles
  if (n.length <= 30) {
    for (let i = 0; i <= h.length - n.length; i++) {
      const window = h.slice(i, i + n.length);
      let diff = 0;
      for (let j = 0; j < n.length; j++) {
        if (window[j] !== n[j]) diff++;
        if (diff > tolerance) break;
      }
      if (diff <= tolerance) return true;
    }
    return false;
  }

  // For longer needles: check key phrases exist
  const phrases = splitIntoPhrases(needle, 15).map(p => compactNormalize(p)).filter(Boolean);
  if (phrases.length === 0) return false;
  const matchCount = phrases.filter(p => h.includes(p)).length;
  return matchCount >= Math.ceil(phrases.length * 0.7);
}

function splitIntoPhrases(text, minLen = 10) {
  // Capture the delimiters (group) so they stay attached to the preceding fragment —
  // dropping them caused phrase strings to mismatch the source text at sentence joins
  // (e.g. "...生效" + "惟不表示..." instead of "...生效，惟不表示...").
  const parts = text.split(/([，。；、！？\n])/);
  const phrases = [];
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    current += parts[i];
    const isDelimiter = i % 2 === 1;
    if (isDelimiter && current.trim().length >= minLen) {
      phrases.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length >= minLen / 2) phrases.push(current.trim());
  return phrases.filter(p => p.length > 0);
}

module.exports = { normalize, compactNormalize, normalizedIncludes, fuzzyIncludes, splitIntoPhrases, toHalfWidth };
