// Small utilities shared by both lab pages.

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
