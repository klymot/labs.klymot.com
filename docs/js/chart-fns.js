/**
 * Pure, DOM-free math/data-processing routines for the klymot chart renderer.
 *
 * This is the single implementation — there is no second copy to keep in
 * sync. It's consumed two ways:
 *   - klymot-chart.js (./klymot-chart.js, a sibling file in public/js/)
 *     imports these functions directly via a native browser ES-module
 *     `import` — both files are static assets served as-is, so this needs
 *     no bundler.
 *   - vitest imports this file directly (see chart-fns.test.js) to exercise
 *     the logic without a browser/canvas environment.
 */

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Parse GHCNm CSV text (no header row).
 * Format: year, jan, feb, …, dec — values in 0.01 °C integers, empty = missing.
 * @param {string} text
 * @returns {Array<{year: number, months: (number|null)[]}>}
 */
export function parseCsv(text) {
  if (!text || !text.trim()) return [];
  const records = [];
  for (const line of text.trim().split('\n')) {
    const cols = line.trim().split(',');
    if (cols.length < 2) continue;
    const year = parseInt(cols[0], 10);
    if (!isFinite(year)) continue;
    const months = [];
    for (let m = 0; m < 12; m++) {
      const raw = (cols[m + 1] ?? '').trim();
      months.push(raw !== '' ? parseInt(raw, 10) : null);
    }
    records.push({ year, months });
  }
  return records.sort((a, b) => a.year - b.year);
}

/**
 * Build point array for monthly display.
 * Nulls appear for missing months and gaps between non-adjacent years.
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @returns {Array<{x: number, y: number, label: string}|null>}
 */
export function monthlyPoints(records) {
  const pts = [];
  let prevYear = null;
  for (const rec of records) {
    if (prevYear !== null && rec.year > prevYear + 1) pts.push(null);
    prevYear = rec.year;
    for (let m = 0; m < 12; m++) {
      pts.push(rec.months[m] != null
        ? { x: rec.year + m / 12, y: rec.months[m] / 100, label: `${MONTHS[m]} ${rec.year}` }
        : null);
    }
  }
  return pts;
}

/**
 * Build per-month point arrays for bymonth display.
 * Returns an array of 12 point arrays; each contains {x: year, y: °C}|null entries.
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @returns {Array<Array<{x: number, y: number}|null>>}
 */
export function byMonthPoints(records) {
  const result = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const hasGap = i > 0 && rec.year > records[i - 1].year + 1;
    for (let m = 0; m < 12; m++) {
      if (hasGap) result[m].push(null);
      result[m].push(rec.months[m] != null
        ? { x: rec.year, y: rec.months[m] / 100 }
        : null);
    }
  }
  return result;
}

/**
 * Build point array for annual-average display.
 * Only complete years (all 12 months present) are included.
 * Year gaps between consecutive complete years produce null (line break).
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @returns {Array<{x: number, y: number, label: string}|null>}
 */
export function yearlyPoints(records) {
  const pts = [];
  let prevYear = null;
  for (const rec of records) {
    if (!rec.months.every(v => v != null)) continue;
    if (prevYear !== null && rec.year > prevYear + 1) pts.push(null);
    const avg = rec.months.reduce((s, v) => s + v, 0) / 12 / 100;
    pts.push({ x: rec.year, y: avg, label: String(rec.year) });
    prevYear = rec.year;
  }
  return pts;
}

/**
 * Build annual mean summaries from all years with at least one valid month.
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @returns {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>}
 */
export function annualSummaries(records) {
  return records
    .map(rec => {
      const months = rec.months.filter(v => v != null);
      if (months.length === 0) return null;
      return {
        year:    rec.year,
        mean:    months.reduce((sum, v) => sum + v, 0) / months.length / 100,
        nMonths: months.length,
        isFull:  months.length === 12,
      };
    })
    .filter(Boolean);
}

/**
 * Pick the full years used as the annual anomaly reference.
 * @param {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>} summaries
 * @param {boolean} useCenteredReference
 * @returns {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>}
 */
export function anomalyReferenceYears(summaries, useCenteredReference) {
  const fullYears = summaries.filter(s => s.isFull);
  if (fullYears.length === 0) return [];

  if (useCenteredReference && fullYears.length > 30) {
    const center = (fullYears[0].year + fullYears[fullYears.length - 1].year) / 2;
    return [...fullYears]
      .sort((a, b) => {
        const da = Math.abs(a.year - center);
        const db = Math.abs(b.year - center);
        return da - db || a.year - b.year;
      })
      .slice(0, 30)
      .sort((a, b) => a.year - b.year);
  }
  return fullYears;
}

/**
 * Build annual anomaly points from annual summaries.
 * Reference mean is always computed from full years only.
 * @param {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>} summaries
 * @param {{ excludeSparse?: boolean, useCenteredReference?: boolean }} options
 * @returns {Array<{x: number, y: number, label: string, nMonths: number, isFull: boolean}|null>}
 */
export function anomalyPoints(summaries, options = {}) {
  const excludeSparse = options.excludeSparse !== false;
  const useCenteredReference = !!options.useCenteredReference;
  const refYears = anomalyReferenceYears(summaries, useCenteredReference);
  if (refYears.length === 0) return [];

  const referenceMean = refYears.reduce((sum, s) => sum + s.mean, 0) / refYears.length;
  const included = summaries.filter(s => excludeSparse ? s.nMonths >= 9 : s.nMonths >= 1);

  const pts = [];
  let prevYear = null;
  for (const summary of included) {
    if (prevYear !== null && summary.year > prevYear + 1) pts.push(null);
    pts.push({
      x:       summary.year,
      y:       summary.mean - referenceMean,
      label:   String(summary.year),
      nMonths: summary.nMonths,
      isFull:  summary.isFull,
    });
    prevYear = summary.year;
  }
  return pts;
}

/**
 * Lag-1 autocorrelation of a residual series (Yule-Walker estimate).
 * Returns a value in (−1, 1); clipped to ±0.99.
 * @param {number[]} res
 * @returns {number}
 */
export function lag1Autocorr(res) {
  const n = res.length;
  if (n < 3) return 0;
  let sum = 0;
  for (const r of res) sum += r;
  const mean = sum / n;
  let ss = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const c = res[i] - mean;
    ss += c * c;
    if (i < n - 1) cross += c * (res[i + 1] - mean);
  }
  if (ss < 1e-30) return 0;
  return Math.max(-0.99, Math.min(0.99, cross / ss));
}

/**
 * Compute a least-squares trend line with AR(1)-corrected standard error.
 * @param {Array<{x: number, y: number}|null>} pts
 * @returns {{ slopePerYear: number, slopePer100Years: number, intercept: number, se: number }|null}
 */
export function trendLine(pts) {
  const values = (pts ?? []).filter(Boolean);
  if (values.length < 2) return null;

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const p of values) {
    sumX += p.x;
    sumY += p.y;
    sumXX += p.x * p.x;
    sumXY += p.x * p.y;
  }

  const n = values.length;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;

  const slopePerYear = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slopePerYear * sumX) / n;

  const residuals = values.map(p => p.y - (intercept + slopePerYear * p.x));
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  const seRaw = n >= 3 ? Math.sqrt(sse * n / ((n - 2) * denom)) : 0;
  const rho = lag1Autocorr(residuals);
  const nEff = Math.max(2, n * (1 - rho) / (1 + rho));
  const se = seRaw * Math.sqrt(n / nEff);

  return { slopePerYear, slopePer100Years: slopePerYear * 100, intercept, se };
}

/**
 * Locally-weighted scatterplot smoothing (LOESS / LOWESS).
 * @param {Array<{x: number, y: number}|null>} pts
 * @param {number} span — fraction of points to use as neighbours (0.1–0.9)
 * @returns {Array<{x: number, y: number}>|null}
 */
export function loess(pts, span) {
  const valid = (pts ?? []).filter(Boolean);
  if (valid.length < 3) return null;
  const n = valid.length;
  const k = Math.min(n, Math.max(3, Math.round(span * n)));
  const result = [];
  for (let i = 0; i < n; i++) {
    const xi = valid[i].x;
    let lo = i, hi = i + 1, count = 1;
    while (count < k) {
      const dLo = lo > 0 ? xi - valid[lo - 1].x : Infinity;
      const dHi = hi < n ? valid[hi].x - xi     : Infinity;
      if (dLo <= dHi) { lo--; } else { hi++; }
      count++;
    }
    const h = Math.max(xi - valid[lo].x, valid[hi - 1].x - xi);
    if (h < 1e-12) { result.push({ x: xi, y: valid[i].y }); continue; }
    let W = 0, WX = 0, WY = 0, WXX = 0, WXY = 0;
    for (let j = lo; j < hi; j++) {
      const u = Math.abs(valid[j].x - xi) / h;
      if (u >= 1) continue;
      const w = Math.pow(1 - u * u * u, 3);
      const { x, y } = valid[j];
      W += w; WX += w * x; WY += w * y; WXX += w * x * x; WXY += w * x * y;
    }
    const det = W * WXX - WX * WX;
    let yFit;
    if (Math.abs(det) < 1e-12) {
      yFit = WY / W;
    } else {
      const slope = (W * WXY - WX * WY) / det;
      const intercept = (WY - slope * WX) / W;
      yFit = intercept + slope * xi;
    }
    result.push({ x: xi, y: yFit });
  }
  return result;
}

/**
 * Invert an n×n matrix using Gauss-Jordan elimination.
 * Returns null if the matrix is singular.
 * @param {number[][]} A
 * @returns {number[][]|null}
 */
export function matInverse(A) {
  const n = A.length;
  const M = A.map((row, i) => {
    const aug = row.map(v => v);
    for (let j = 0; j < n; j++) aug.push(j === i ? 1 : 0);
    return aug;
  });

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) return null;

    const invPivot = 1 / pivot;
    for (let j = 0; j < 2 * n; j++) M[col][j] *= invPivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[row][j] -= f * M[col][j];
    }
  }

  return M.map(row => row.slice(n));
}

/**
 * Calibrate a month-to-annual estimator from complete years, then apply GLS
 * to estimate annual means for partial years (with 95% CI).
 *
 * Works in 0.01 K (Kelvin offset = 27315) to keep ratio estimator well-conditioned.
 *
 * @param {Array<{year: number, months: (number|null)[]}>} records — values in 0.01 °C
 * @returns {Array<{year: number, estimate: number, se: number, ciLow: number, ciHigh: number, nMonths: number}>}
 */
export function calibrateAndEstimate(records) {
  const complete = records.filter(r => r.months.every(v => v != null));
  const partial  = records.filter(r =>
    !r.months.every(v => v != null) && r.months.some(v => v != null));

  if (complete.length < 3 || partial.length === 0) return [];

  const K = 27315;

  const T = new Array(12).fill(0);
  for (const yr of complete) {
    for (let i = 0; i < 12; i++) T[i] += yr.months[i] + K;
  }
  for (let i = 0; i < 12; i++) T[i] /= complete.length;

  const A = T.reduce((s, v) => s + v, 0) / 12;

  const residuals = complete.map(yr => {
    const Ay = yr.months.reduce((s, v) => s + v + K, 0) / 12;
    return yr.months.map((v, i) => (A * (v + K) / T[i]) - Ay);
  });

  const n = complete.length;
  const Sigma = Array.from({ length: 12 }, () => new Array(12).fill(0));
  for (let i = 0; i < 12; i++) {
    for (let j = i; j < 12; j++) {
      let cov = 0;
      for (const r of residuals) cov += r[i] * r[j];
      Sigma[i][j] = Sigma[j][i] = cov / (n - 1);
    }
  }

  const results = [];
  for (const rec of partial) {
    const obsIdx = rec.months.reduce((acc, v, i) => { if (v != null) acc.push(i); return acc; }, []);
    if (obsIdx.length === 0) continue;

    const ES = obsIdx.map(i => A * (rec.months[i] + K) / T[i]);

    const k = obsIdx.length;
    let hatA, se;

    const SigmaS = Array.from({ length: k }, (_, ri) =>
      Array.from({ length: k }, (_, ci) => Sigma[obsIdx[ri]][obsIdx[ci]])
    );
    const SigmaSInv = matInverse(SigmaS);

    if (SigmaSInv) {
      let denom = 0, numer = 0;
      for (let ri = 0; ri < k; ri++) {
        let rowSumInv = 0, rowSumInvE = 0;
        for (let ci = 0; ci < k; ci++) {
          rowSumInv  += SigmaSInv[ri][ci];
          rowSumInvE += SigmaSInv[ri][ci] * ES[ci];
        }
        denom += rowSumInv;
        numer += rowSumInvE;
      }
      if (denom <= 0) continue;
      hatA = numer / denom;
      se   = Math.sqrt(1 / denom);
    } else {
      let sumW = 0, sumWE = 0;
      for (let ki = 0; ki < k; ki++) {
        const v = Sigma[obsIdx[ki]][obsIdx[ki]];
        if (v <= 0) continue;
        const w = 1 / v;
        sumW  += w;
        sumWE += w * ES[ki];
      }
      if (sumW <= 0) continue;
      hatA = sumWE / sumW;
      se   = Math.sqrt(1 / sumW);
    }

    const estimate = (hatA - K) / 100;
    const seDeg    = se / 100;
    results.push({
      year:    rec.year,
      estimate,
      se:      seDeg,
      ciLow:   estimate - 1.96 * seDeg,
      ciHigh:  estimate + 1.96 * seDeg,
      nMonths: k,
    });
  }

  return results;
}

/**
 * Pick a tick step giving ~targetCount ticks across range.
 * @param {number} range
 * @param {number} targetCount
 * @returns {number}
 */
export function niceStep(range, targetCount) {
  if (range <= 0 || !isFinite(range)) return 1;
  const rough = range / targetCount;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const n     = rough / mag;
  const step  = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * mag;
}
