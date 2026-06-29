import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  monthlyPoints,
  yearlyPoints,
  annualSummaries,
  anomalyPoints,
  trendLine,
  loess,
  matInverse,
  calibrateAndEstimate,
  niceStep,
} from './chart-fns.js';

// ── parseCsv ──────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('returns empty array for empty or whitespace input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('   ')).toEqual([]);
    expect(parseCsv(null)).toEqual([]);
  });

  it('parses a single complete row', () => {
    const text = '2023,100,200,300,400,500,600,700,800,900,1000,1100,1200';
    const result = parseCsv(text);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2023);
    expect(result[0].months).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  });

  it('parses missing months as null', () => {
    const text = '2023,100,,300';
    const result = parseCsv(text);
    expect(result[0].months[0]).toBe(100);
    expect(result[0].months[1]).toBeNull();
    expect(result[0].months[2]).toBe(300);
    expect(result[0].months[3]).toBeNull();
  });

  it('skips rows with non-numeric year', () => {
    const text = 'bad,100,200,300\n2020,50,60,70';
    const result = parseCsv(text);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2020);
  });

  it('sorts output by year', () => {
    const text = '2022,100,100,100,100,100,100,100,100,100,100,100,100\n2020,200,200,200,200,200,200,200,200,200,200,200,200';
    const result = parseCsv(text);
    expect(result[0].year).toBe(2020);
    expect(result[1].year).toBe(2022);
  });
});

// ── yearlyPoints ──────────────────────────────────────────────────────────────

describe('yearlyPoints', () => {
  const completeYear = (year, value) => ({
    year,
    months: Array(12).fill(value),
  });

  it('returns empty array for no records', () => {
    expect(yearlyPoints([])).toEqual([]);
  });

  it('includes only complete years', () => {
    const records = [
      completeYear(2020, 1000),
      { year: 2021, months: [1000, null, ...Array(10).fill(1000)] },
    ];
    const pts = yearlyPoints(records);
    expect(pts.filter(Boolean)).toHaveLength(1);
    expect(pts[0].x).toBe(2020);
  });

  it('computes correct annual average in °C', () => {
    const records = [completeYear(2000, 1050)];
    const pts = yearlyPoints(records);
    expect(pts[0].y).toBeCloseTo(10.5, 5);
  });

  it('inserts null between non-adjacent complete years', () => {
    const records = [completeYear(2000, 1000), completeYear(2002, 1000)];
    const pts = yearlyPoints(records);
    expect(pts.some(p => p === null)).toBe(true);
  });

  it('does not insert null between adjacent complete years', () => {
    const records = [completeYear(2000, 1000), completeYear(2001, 1000)];
    const pts = yearlyPoints(records);
    expect(pts.every(p => p !== null)).toBe(true);
  });
});

// ── annualSummaries ───────────────────────────────────────────────────────────

describe('annualSummaries', () => {
  it('returns empty for empty records', () => {
    expect(annualSummaries([])).toEqual([]);
  });

  it('marks complete years as isFull', () => {
    const rec = { year: 2020, months: Array(12).fill(1200) };
    const result = annualSummaries([rec]);
    expect(result[0].isFull).toBe(true);
    expect(result[0].nMonths).toBe(12);
    expect(result[0].mean).toBeCloseTo(12.0, 5);
  });

  it('handles partial years', () => {
    const months = [1200, null, ...Array(10).fill(null)];
    const rec = { year: 2021, months };
    const result = annualSummaries([rec]);
    expect(result[0].isFull).toBe(false);
    expect(result[0].nMonths).toBe(1);
    expect(result[0].mean).toBeCloseTo(12.0, 5);
  });

  it('excludes years with no valid months', () => {
    const rec = { year: 2020, months: Array(12).fill(null) };
    expect(annualSummaries([rec])).toHaveLength(0);
  });
});

// ── anomalyPoints ─────────────────────────────────────────────────────────────

describe('anomalyPoints', () => {
  const makeRecords = (years, value) =>
    years.map(y => ({ year: y, months: Array(12).fill(value) }));

  it('returns empty when no full years exist', () => {
    const summaries = [{ year: 2020, mean: 10, nMonths: 6, isFull: false }];
    expect(anomalyPoints(summaries)).toEqual([]);
  });

  it('computes zero anomaly when all years equal the reference mean', () => {
    const records = makeRecords([2000, 2001, 2002, 2003, 2004], 1000);
    const sums = annualSummaries(records);
    const pts = anomalyPoints(sums, { excludeSparse: false });
    for (const p of pts.filter(Boolean)) {
      expect(p.y).toBeCloseTo(0, 8);
    }
  });

  it('computes correct signed anomaly relative to reference mean', () => {
    const records = [
      { year: 2000, months: Array(12).fill(1000) },
      { year: 2001, months: Array(12).fill(1100) },
      { year: 2002, months: Array(12).fill(1200) },
    ];
    const sums = annualSummaries(records);
    const pts = anomalyPoints(sums, { excludeSparse: false });
    const byYear = Object.fromEntries(pts.filter(Boolean).map(p => [p.x, p.y]));
    // reference mean = (10 + 11 + 12) / 3 = 11°C
    expect(byYear[2000]).toBeCloseTo(-1.0, 5);
    expect(byYear[2001]).toBeCloseTo(0.0, 5);
    expect(byYear[2002]).toBeCloseTo(1.0, 5);
  });

  it('excludes sparse years (< 9 months) by default', () => {
    const records = [
      { year: 2000, months: Array(12).fill(1000) },
      { year: 2001, months: Array(12).fill(1000) },
      { year: 2002, months: Array(12).fill(1000) },
      { year: 2003, months: [1000, null, ...Array(10).fill(null)] },
    ];
    const sums = annualSummaries(records);
    const pts = anomalyPoints(sums, { excludeSparse: true });
    expect(pts.filter(Boolean).map(p => p.x)).not.toContain(2003);
  });
});

// ── trendLine ─────────────────────────────────────────────────────────────────

describe('trendLine', () => {
  it('returns null for fewer than 2 points', () => {
    expect(trendLine([])).toBeNull();
    expect(trendLine([null])).toBeNull();
    expect(trendLine([{ x: 2000, y: 10 }])).toBeNull();
  });

  it('returns null for all identical x values', () => {
    const pts = [{ x: 2000, y: 10 }, { x: 2000, y: 12 }];
    expect(trendLine(pts)).toBeNull();
  });

  it('recovers exact slope and intercept for a perfect linear series', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({
      x: 2000 + i,
      y: 2 * (2000 + i) - 3980, // slope=2, intercept=-3980
    }));
    const result = trendLine(pts);
    expect(result).not.toBeNull();
    expect(result.slopePerYear).toBeCloseTo(2, 6);
    expect(result.slopePer100Years).toBeCloseTo(200, 4);
    expect(result.intercept).toBeCloseTo(-3980, 2);
  });

  it('reports ~zero slope for a constant series', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: 2000 + i, y: 10.0 }));
    const result = trendLine(pts);
    expect(Math.abs(result.slopePerYear)).toBeLessThan(1e-10);
    expect(result.se).toBeCloseTo(0, 10);
  });

  it('skips null entries', () => {
    const pts = [{ x: 2000, y: 0 }, null, { x: 2002, y: 2 }];
    const result = trendLine(pts);
    expect(result.slopePerYear).toBeCloseTo(1, 6);
  });

  it('returns a non-negative se', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: 1990 + i, y: i * 0.05 + (Math.sin(i) * 0.1) }));
    const result = trendLine(pts);
    expect(result.se).toBeGreaterThanOrEqual(0);
  });
});

// ── matInverse ────────────────────────────────────────────────────────────────

describe('matInverse', () => {
  const approxEqual = (A, B, tol = 1e-9) => {
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < A[i].length; j++) {
        if (Math.abs(A[i][j] - B[i][j]) > tol) return false;
      }
    }
    return true;
  };

  it('inverts the 2×2 identity matrix', () => {
    const I = [[1, 0], [0, 1]];
    const result = matInverse(I);
    expect(approxEqual(result, I)).toBe(true);
  });

  it('inverts a known 2×2 matrix', () => {
    // [[2,1],[1,2]]^-1 = [[2/3,-1/3],[-1/3,2/3]]
    const A = [[2, 1], [1, 2]];
    const result = matInverse(A);
    expect(result[0][0]).toBeCloseTo(2 / 3, 9);
    expect(result[0][1]).toBeCloseTo(-1 / 3, 9);
    expect(result[1][0]).toBeCloseTo(-1 / 3, 9);
    expect(result[1][1]).toBeCloseTo(2 / 3, 9);
  });

  it('inverts a 3×3 matrix and satisfies A * A^-1 = I', () => {
    const A = [[1, 2, 3], [0, 1, 4], [5, 6, 0]];
    const Ainv = matInverse(A);
    expect(Ainv).not.toBeNull();
    // Verify A @ A^-1 ≈ I
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const entry = A[i].reduce((s, _, k) => s + A[i][k] * Ainv[k][j], 0);
        expect(entry).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });

  it('returns null for a singular matrix', () => {
    const singular = [[1, 2], [2, 4]];
    expect(matInverse(singular)).toBeNull();
  });
});

// ── loess ─────────────────────────────────────────────────────────────────────

describe('loess', () => {
  it('returns null for fewer than 3 non-null points', () => {
    expect(loess([], 0.5)).toBeNull();
    expect(loess([{ x: 1, y: 1 }, { x: 2, y: 2 }], 0.5)).toBeNull();
    expect(loess([null, { x: 1, y: 1 }, null], 0.5)).toBeNull();
  });

  it('output length equals the number of non-null input points', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: Math.sin(i) }));
    const result = loess(pts, 0.4);
    expect(result).toHaveLength(20);
  });

  it('smooths a noisy linear signal to near the true line', () => {
    // True line: y = 0.5x. Add small perturbations.
    const noise = [0.05, -0.03, 0.07, -0.02, 0.04, -0.06, 0.01, 0.03, -0.05, 0.02,
                   0.04, -0.01, 0.06, -0.04, 0.02, -0.03, 0.05, -0.02, 0.03, -0.01];
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0.5 * i + noise[i] }));
    const result = loess(pts, 0.5);
    for (let i = 5; i < 15; i++) {
      expect(result[i].y).toBeCloseTo(0.5 * i, 0);
    }
  });
});

// ── calibrateAndEstimate ──────────────────────────────────────────────────────

describe('calibrateAndEstimate', () => {
  it('returns empty when fewer than 3 complete years', () => {
    const records = [
      { year: 2000, months: Array(12).fill(1000) },
      { year: 2001, months: Array(12).fill(1000) },
      { year: 2002, months: [1000, null, ...Array(10).fill(1000)] },
    ];
    expect(calibrateAndEstimate(records)).toEqual([]);
  });

  it('returns empty when no partial years exist', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      year: 2000 + i,
      months: Array(12).fill(1000),
    }));
    expect(calibrateAndEstimate(records)).toEqual([]);
  });

  it('estimates partial-year annual mean close to true value', () => {
    // Seasonal pattern (0.01°C): ranges from 100 (Jan) to 700 (Jul) with a peak.
    const seasonal = [100, 200, 400, 600, 800, 1000, 1100, 1000, 800, 600, 400, 200];
    // 10 complete years with inter-annual offsets (ensures non-zero covariance).
    const offsets = [-200, -150, -100, -50, 0, 50, 100, 150, 200, 250];
    const records = offsets.map((offset, idx) => ({
      year: 2000 + idx,
      months: seasonal.map(s => s + offset),
    }));

    // Partial year 2010: only first 6 months present, offset = 300.
    const partialOffset = 300;
    const partialMonths = seasonal.map((s, m) => (m < 6 ? s + partialOffset : null));
    records.push({ year: 2010, months: partialMonths });

    // True annual mean for 2010 = (sum(seasonal)/12 + partialOffset) / 100
    const trueAnnual = (seasonal.reduce((a, b) => a + b, 0) / 12 + partialOffset) / 100;

    const results = calibrateAndEstimate(records);
    expect(results).toHaveLength(1);
    expect(results[0].year).toBe(2010);
    expect(results[0].estimate).toBeCloseTo(trueAnnual, 0); // within 0.5°C
    expect(results[0].nMonths).toBe(6);
    expect(results[0].ciHigh).toBeGreaterThan(results[0].estimate);
    expect(results[0].ciLow).toBeLessThan(results[0].estimate);
  });
});

// ── niceStep ─────────────────────────────────────────────────────────────────

describe('niceStep', () => {
  it('returns 1 for zero or negative range', () => {
    expect(niceStep(0, 5)).toBe(1);
    expect(niceStep(-10, 5)).toBe(1);
  });

  it('returns 1 for non-finite range', () => {
    expect(niceStep(Infinity, 5)).toBe(1);
    expect(niceStep(NaN, 5)).toBe(1);
  });

  it('picks a step that produces roughly the right number of ticks', () => {
    // Range 100, 5 ticks → step should be 20
    expect(niceStep(100, 5)).toBe(20);
    // Range 10, 5 ticks → step should be 2
    expect(niceStep(10, 5)).toBe(2);
    // Range 50, 5 ticks → step should be 10
    expect(niceStep(50, 5)).toBe(10);
  });

  it('always returns a positive step', () => {
    for (const range of [0.001, 1, 100, 10000]) {
      expect(niceStep(range, 6)).toBeGreaterThan(0);
    }
  });
});
