// Pure statistics helpers shared by the two Error Bars labs (Temperature and
// Sunshine) — the "build your own error bars" skeleton applied to two
// different variables.
//
// Everything works on *pairs*: periods where both the measured series (a) and
// the modelled series (b) have a value. The difference convention is a − b
// (measured minus modelled) everywhere, and the labs state it wherever a
// difference is shown. Aggregation always masks to days/months where both
// series are present, so a gap in one series can't make the two sides average
// over different parts of a period.

import { buildHistogram } from './cherry-picking-stats.js';

export { buildHistogram };

// Fewest differences a frozen band may rest on. Below this, quantiles of the
// difference distribution are too ragged to call a band at all.
export const MIN_DIFFS_FOR_BAND = 30;

export const COVERAGE_LEVELS = [0.5, 0.8, 0.9, 0.95];

/* ── Calendar helpers ────────────────────────────────────────────────────── */

const MS_PER_DAY = 86400000;

function isoAddDays(startIso, offset) {
  const t = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  ) + offset * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

function ymAddMonths(startYm, offset) {
  const y = Number(startYm.slice(0, 4));
  const m = Number(startYm.slice(5, 7)) - 1 + offset;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, '0')}-${String(mm + 1).padStart(2, '0')}`;
}

/* ── Building pairs ──────────────────────────────────────────────────────── */

/**
 * Daily pairs from a sunshine site's aligned calendar arrays.
 * @param {{start: string, measured: (number|null)[], modelled: (number|null)[]}} daily
 * @returns {Array<{key: string, a: number, b: number}>} — key "YYYY-MM-DD"
 */
export function dailyPairs(daily) {
  const out = [];
  const n = Math.min(daily.measured.length, daily.modelled.length);
  for (let i = 0; i < n; i++) {
    const a = daily.measured[i];
    const b = daily.modelled[i];
    if (a == null || b == null) continue;
    out.push({ key: isoAddDays(daily.start, i), a, b });
  }
  return out;
}

/**
 * Monthly pairs from daily pairs: each month's mean of a and of b over the
 * days where BOTH are present, kept only when those common days cover at
 * least minFraction of the calendar month.
 * @param {Array<{key: string, a: number, b: number}>} pairs — daily
 * @param {number} minFraction
 * @returns {Array<{key: string, a: number, b: number, n: number}>} — key "YYYY-MM"
 */
export function monthlyPairsFromDaily(pairs, minFraction = 0.8) {
  const byMonth = new Map();
  pairs.forEach((p) => {
    const ym = p.key.slice(0, 7);
    let acc = byMonth.get(ym);
    if (!acc) { acc = { sumA: 0, sumB: 0, n: 0 }; byMonth.set(ym, acc); }
    acc.sumA += p.a;
    acc.sumB += p.b;
    acc.n += 1;
  });
  const out = [];
  for (const [ym, acc] of byMonth) {
    const days = daysInMonth(ym);
    if (acc.n / days < minFraction) continue;
    out.push({ key: ym, a: acc.sumA / acc.n, b: acc.sumB / acc.n, n: acc.n });
  }
  out.sort((x, y) => (x.key < y.key ? -1 : 1));
  return out;
}

export function daysInMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Monthly pairs for the temperature lab: parsed GHCNm records (0.01 °C,
 * null-padded months) against a modelled monthly calendar block (°C).
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @param {{start: string, modelled: (number|null)[]}} monthly
 * @returns {Array<{key: string, a: number, b: number}>} — key "YYYY-MM", °C
 */
export function monthlyPairsFromGhcn(records, monthly) {
  const modelledByYm = new Map();
  monthly.modelled.forEach((v, i) => {
    if (v != null) modelledByYm.set(ymAddMonths(monthly.start, i), v);
  });
  const out = [];
  (records ?? []).forEach((rec) => {
    rec.months.forEach((v, mi) => {
      if (v == null) return;
      const ym = `${String(rec.year).padStart(4, '0')}-${String(mi + 1).padStart(2, '0')}`;
      const b = modelledByYm.get(ym);
      if (b == null) return;
      out.push({ key: ym, a: v / 100, b });
    });
  });
  out.sort((x, y) => (x.key < y.key ? -1 : 1));
  return out;
}

/**
 * Annual pairs from monthly pairs — all 12 months required, so a missing
 * winter can't skew a year.
 * @param {Array<{key: string, a: number, b: number}>} monthlyPairs
 * @returns {Array<{key: string, a: number, b: number}>} — key "YYYY"
 */
export function annualPairsFromMonthly(monthlyPairs) {
  const byYear = new Map();
  monthlyPairs.forEach((p) => {
    const y = p.key.slice(0, 4);
    let acc = byYear.get(y);
    if (!acc) { acc = { sumA: 0, sumB: 0, n: 0 }; byYear.set(y, acc); }
    acc.sumA += p.a;
    acc.sumB += p.b;
    acc.n += 1;
  });
  const out = [];
  for (const [y, acc] of byYear) {
    if (acc.n !== 12) continue;
    out.push({ key: y, a: acc.sumA / 12, b: acc.sumB / 12 });
  }
  out.sort((x, y) => (x.key < y.key ? -1 : 1));
  return out;
}

const SEASON_OF_MONTH = ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'];

/**
 * Seasonal pairs (DJF/MAM/JJA/SON) from monthly pairs; all three months
 * required. December belongs to the following year's DJF.
 * @param {Array<{key: string, a: number, b: number}>} monthlyPairs
 * @returns {Array<{key: string, a: number, b: number}>} — key "YYYY-DJF"
 */
export function seasonalPairsFromMonthly(monthlyPairs) {
  const bySeason = new Map();
  monthlyPairs.forEach((p) => {
    const y = Number(p.key.slice(0, 4));
    const m = Number(p.key.slice(5, 7));
    const season = SEASON_OF_MONTH[m - 1];
    const seasonYear = m === 12 ? y + 1 : y;
    const key = `${seasonYear}-${season}`;
    let acc = bySeason.get(key);
    if (!acc) { acc = { sumA: 0, sumB: 0, n: 0 }; bySeason.set(key, acc); }
    acc.sumA += p.a;
    acc.sumB += p.b;
    acc.n += 1;
  });
  const out = [];
  for (const [key, acc] of bySeason) {
    if (acc.n !== 3) continue;
    out.push({ key, a: acc.sumA / 3, b: acc.sumB / 3 });
  }
  const order = { DJF: 0, MAM: 1, JJA: 2, SON: 3 };
  out.sort((x, y) => {
    const [xy, xs] = x.key.split('-');
    const [yy, ys] = y.key.split('-');
    return xy !== yy ? Number(xy) - Number(yy) : order[xs] - order[ys];
  });
  return out;
}

/* ── Differences, bands, transfer ────────────────────────────────────────── */

/**
 * Differences under the stated convention: measured minus modelled.
 * @param {Array<{key: string, a: number, b: number}>} pairs
 * @returns {number[]}
 */
export function differences(pairs) {
  return pairs.map((p) => p.a - p.b);
}

/**
 * Linear-interpolation quantile (R type 7) of an unsorted sample.
 * @param {number[]} values
 * @param {number} p — 0..1
 * @returns {number|null}
 */
export function quantile(values, p) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((x, y) => x - y);
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Central empirical band containing `coverage` of the differences.
 * Returns null when there are too few differences to call a band.
 * @param {number[]} diffs
 * @param {number} coverage — e.g. 0.9
 * @returns {{lo: number, hi: number, n: number, coverage: number}|null}
 */
export function empiricalBand(diffs, coverage) {
  if (!diffs || diffs.length < MIN_DIFFS_FOR_BAND) return null;
  const tail = (1 - coverage) / 2;
  return {
    lo: quantile(diffs, tail),
    hi: quantile(diffs, 1 - tail),
    n: diffs.length,
    coverage,
  };
}

/**
 * Transfer test: at another site, how many measured values fall inside
 * [modelled + band.lo, modelled + band.hi]?
 * @param {Array<{key: string, a: number, b: number}>} pairs — target site
 * @param {{lo: number, hi: number}} band
 * @returns {{inside: number, n: number, fraction: number}|null}
 */
export function transferCoverage(pairs, band) {
  if (!pairs || !pairs.length || !band) return null;
  let inside = 0;
  pairs.forEach((p) => {
    if (p.a >= p.b + band.lo && p.a <= p.b + band.hi) inside++;
  });
  return { inside, n: pairs.length, fraction: inside / pairs.length };
}

/**
 * Simple summary of a difference sample for readouts.
 * @param {number[]} diffs
 * @returns {{n: number, mean: number, median: number}|null}
 */
export function summarizeDiffs(diffs) {
  if (!diffs || !diffs.length) return null;
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  return { n: diffs.length, mean, median: quantile(diffs, 0.5) };
}
