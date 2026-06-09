/**
 * Display-time formatting helpers — convert stored timestamps to Taipei local time.
 *
 * SQLite's datetime('now') (used for created_at/etc.) always returns UTC strings
 * with no timezone marker (e.g. "2026-06-07 13:10:00"). JS's Date parser treats
 * such marker-less strings as LOCAL time, which silently round-trips the same
 * numbers back through toLocaleString() regardless of the container's TZ —
 * showing the raw UTC numbers mislabeled as local. We must mark them as UTC
 * before converting, then explicitly format in Asia/Taipei.
 */

const TAIPEI_TZ = 'Asia/Taipei';

function toUtcDate(value) {
  if (!value) return null;
  const str = String(value);
  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(str);
  return new Date(hasTimezone ? str : str.replace(' ', 'T') + 'Z');
}

function formatDateTime(value) {
  const d = toUtcDate(value);
  return d ? d.toLocaleString('zh-TW', { timeZone: TAIPEI_TZ }) : '';
}

function formatDate(value) {
  const d = toUtcDate(value);
  return d ? d.toLocaleDateString('zh-TW', { timeZone: TAIPEI_TZ }) : '';
}

module.exports = { formatDateTime, formatDate };
