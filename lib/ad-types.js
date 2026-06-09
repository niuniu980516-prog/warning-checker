/**
 * Canonical list of 廣告類型 (ad types).
 *
 * An upload can be tagged with one or more of these. Each check item can declare
 * which ad types it applies to (stored as a JSON array on check_items.ad_types).
 * A check item with an EMPTY ad_types list applies to ALL ad types (no restriction).
 * A check item only runs when at least one of its ad types matches one of the
 * upload's selected ad types.
 */
const AD_TYPES = [
  '平面廣告-非網站',
  '平面廣告-網站',
  '有聲廣告-影像',
  '有聲廣告-聲音',
  'ETF IPO期間廣告',
  '銷售機構教育訓練資料',
  '付費置入性行銷廣告',
];

// Does a check item (with ad_types `itemAdTypes`) apply to an upload tagged with
// `selectedAdTypes`? Empty/absent item list = applies to everything. Empty
// selection on the upload = run everything (no filtering).
function itemAppliesToAdTypes(itemAdTypes, selectedAdTypes) {
  const item = Array.isArray(itemAdTypes) ? itemAdTypes.filter(Boolean) : [];
  const selected = Array.isArray(selectedAdTypes) ? selectedAdTypes.filter(Boolean) : [];
  if (item.length === 0) return true;       // item applies to all ad types
  if (selected.length === 0) return true;    // user didn't restrict — run everything
  return item.some(t => selected.includes(t));
}

function parseAdTypes(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return []; }
  }
  return [];
}

module.exports = { AD_TYPES, itemAppliesToAdTypes, parseAdTypes };
