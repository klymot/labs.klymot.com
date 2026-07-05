import { describe, it, expect } from 'vitest';
import {
  WINDOW_LENGTHS,
  annualMeans,
  minYearsForWindow,
  windowTrend,
  validStartYears,
  fullRecordTrend,
  buildHistogram,
  stepsBetween,
} from './cherry-picking-stats.js';

// Build parsed-GHCNm-style records: value in 0.01 °C, same value all 12 months.
function record(year, centi) {
  return { year, months: new Array(12).fill(centi) };
}

// Annual series with an exact linear ramp: mean = base + slope·(year − y0), °C.
function ramp(y0, n, base, slopePerYear) {
  return Array.from({ length: n }, (_, i) => ({
    year: y0 + i,
    mean: base + slopePerYear * i,
  }));
}

// ── annualMeans ───────────────────────────────────────────────────────────────

describe('annualMeans', () => {
  it('averages the twelve monthly values and converts 0.01 °C to °C', () => {
    const recs = [{ year: 1900, months: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200] }];
    expect(annualMeans(recs)).toEqual([{ year: 1900, mean: 6.5 }]);
  });

  it('drops any year with a missing month', () => {
    const incomplete = { year: 1901, months: [100, null, ...new Array(10).fill(100)] };
    const result = annualMeans([record(1900, 500), incomplete, record(1902, 700)]);
    expect(result.map(d => d.year)).toEqual([1900, 1902]);
  });

  it('sorts by year and handles empty input', () => {
    expect(annualMeans([])).toEqual([]);
    expect(annualMeans(null)).toEqual([]);
    const result = annualMeans([record(1950, 0), record(1900, 0)]);
    expect(result.map(d => d.year)).toEqual([1900, 1950]);
  });
});

// ── minYearsForWindow ─────────────────────────────────────────────────────────

describe('minYearsForWindow', () => {
  it('requires 80% of the window, never fewer than 3 years', () => {
    expect(minYearsForWindow(15)).toBe(12);
    expect(minYearsForWindow(20)).toBe(16);
    expect(minYearsForWindow(30)).toBe(24);
    expect(minYearsForWindow(60)).toBe(48);
    expect(minYearsForWindow(90)).toBe(72);
    expect(minYearsForWindow(3)).toBe(3);
  });

  it('covers every window length the lab offers', () => {
    for (const len of WINDOW_LENGTHS) {
      expect(minYearsForWindow(len)).toBeGreaterThanOrEqual(3);
      expect(minYearsForWindow(len)).toBeLessThanOrEqual(len);
    }
  });
});

// ── windowTrend ───────────────────────────────────────────────────────────────

describe('windowTrend', () => {
  it('recovers the slope of an exact linear ramp, in °C per decade', () => {
    const annual = ramp(1900, 50, 10, 0.02); // +0.02 °C/yr = +0.2 °C/decade
    const t = windowTrend(annual, 1910, 10);
    expect(t).not.toBeNull();
    expect(t.slopePerDecade).toBeCloseTo(0.2, 6);
    expect(t.startYear).toBe(1910);
    expect(t.endYear).toBe(1919);
    expect(t.nYears).toBe(10);
    expect(t.ciHalfPerDecade).toBeCloseTo(0, 6); // no residual noise
    // Line geometry for drawing: pivot sits at the window's mean year, on the ramp.
    expect(t.meanYear).toBeCloseTo(1914.5, 6);
    expect(t.intercept + t.slopePerYear * 1914.5).toBeCloseTo(10 + 0.02 * 14.5, 6);
  });

  it('finds opposite-sign slopes in different windows of the same record', () => {
    // A record that rises then falls: 1900–1949 up, 1950–1999 down.
    const up = ramp(1900, 50, 10, 0.05);
    const down = ramp(1950, 50, 10 + 0.05 * 50, -0.05);
    const annual = [...up, ...down];
    expect(windowTrend(annual, 1910, 10).slopePerDecade).toBeGreaterThan(0);
    expect(windowTrend(annual, 1960, 10).slopePerDecade).toBeLessThan(0);
  });

  it('tolerates gaps down to the 80% floor and rejects windows below it', () => {
    const annual = ramp(1900, 10, 10, 0.02).filter(d => d.year !== 1903 && d.year !== 1906);
    expect(windowTrend(annual, 1900, 10)).not.toBeNull(); // 8 of 10 present
    const sparse = annual.filter(d => d.year !== 1908);
    expect(windowTrend(sparse, 1900, 10)).toBeNull(); // 7 of 10 present
  });

  it('returns null when the window falls outside the record', () => {
    const annual = ramp(1900, 20, 10, 0.01);
    expect(windowTrend(annual, 1990, 10)).toBeNull();
  });
});

// ── validStartYears ───────────────────────────────────────────────────────────

describe('validStartYears', () => {
  it('lists every start whose window fits inside a gap-free record', () => {
    const annual = ramp(1900, 30, 10, 0);
    const starts = validStartYears(annual, 10);
    expect(starts[0]).toBe(1900);
    expect(starts[starts.length - 1]).toBe(1920);
    expect(starts.length).toBe(21);
  });

  it('excludes starts whose window has too many missing years', () => {
    // 1910–1914 missing: any 10-year window overlapping the gap by 3+ years drops out.
    const annual = ramp(1900, 30, 10, 0).filter(d => d.year < 1910 || d.year > 1914);
    const starts = validStartYears(annual, 10);
    expect(starts).not.toContain(1905); // covers all 5 missing years
    expect(starts).toContain(1900);     // covers none
    expect(starts).toContain(1913);     // covers 2 of the missing years — 8 present
  });

  it('handles records shorter than the window and empty input', () => {
    expect(validStartYears(ramp(1900, 5, 10, 0), 10)).toEqual([]);
    expect(validStartYears([], 10)).toEqual([]);
  });
});

// ── fullRecordTrend ───────────────────────────────────────────────────────────

describe('fullRecordTrend', () => {
  it('fits the whole record and reports its span', () => {
    const annual = ramp(1900, 100, 10, 0.01);
    const t = fullRecordTrend(annual);
    expect(t.slopePerDecade).toBeCloseTo(0.1, 6);
    expect(t.startYear).toBe(1900);
    expect(t.endYear).toBe(1999);
    expect(t.nYears).toBe(100);
  });

  it('returns null for records too short to fit', () => {
    expect(fullRecordTrend(ramp(1900, 2, 10, 0))).toBeNull();
    expect(fullRecordTrend([])).toBeNull();
  });
});

// ── buildHistogram ────────────────────────────────────────────────────────────

describe('buildHistogram', () => {
  it('bins values with edges aligned to multiples of the bin width', () => {
    const h = buildHistogram([-0.35, -0.1, 0.05, 0.05, 0.4], 10);
    expect(h).not.toBeNull();
    const total = h.counts.reduce((s, c) => s + c, 0);
    expect(total).toBe(5);
    expect(h.start / h.binWidth).toBeCloseTo(Math.round(h.start / h.binWidth), 6);
    // Every value lands inside [start, start + nBins·width]
    expect(h.start).toBeLessThanOrEqual(-0.35);
    expect(h.start + h.counts.length * h.binWidth).toBeGreaterThanOrEqual(0.4);
  });

  it('handles a single repeated value without a zero-width range', () => {
    const h = buildHistogram([0.2, 0.2, 0.2], 10);
    expect(h).not.toBeNull();
    expect(h.counts.reduce((s, c) => s + c, 0)).toBe(3);
    expect(h.binWidth).toBeGreaterThan(0);
  });

  it('returns null for empty input', () => {
    expect(buildHistogram([], 10)).toBeNull();
    expect(buildHistogram(null, 10)).toBeNull();
  });
});

// ── stepsBetween ──────────────────────────────────────────────────────────────

describe('stepsBetween', () => {
  it('walks forwards and backwards inclusively', () => {
    expect(stepsBetween(3, 6)).toEqual([3, 4, 5, 6]);
    expect(stepsBetween(6, 3)).toEqual([6, 5, 4, 3]);
    expect(stepsBetween(4, 4)).toEqual([4]);
  });
});
