import { describe, expect, it } from 'vitest';
import {
  ANOMALY_BASELINE,
  MIN_DIFFS_FOR_BAND,
  annualPairsFromMonthly,
  dailyPairs,
  daysInMonth,
  differences,
  empiricalBand,
  monthlyAnomalies,
  monthlyPairsFromDaily,
  monthlyPairsFromGhcn,
  quantile,
  seasonalPairsFromMonthly,
  summarizeDiffs,
  transferCoverage,
} from './error-bars-stats.js';

/* ── dailyPairs ────────────────────────────────────────────────────────── */

describe('dailyPairs', () => {
  it('keeps only days where both series have values, with ISO keys', () => {
    const daily = {
      start: '2020-01-30',
      measured: [1, null, 3, 4],
      modelled: [10, 20, null, 40],
    };
    expect(dailyPairs(daily)).toEqual([
      { key: '2020-01-30', a: 1, b: 10 },
      { key: '2020-02-02', a: 4, b: 40 },
    ]);
  });

  it('crosses leap-year February correctly', () => {
    const daily = { start: '2020-02-28', measured: [1, 2, 3], modelled: [1, 2, 3] };
    expect(dailyPairs(daily).map((p) => p.key)).toEqual([
      '2020-02-28', '2020-02-29', '2020-03-01',
    ]);
  });

  it('returns empty for empty arrays', () => {
    expect(dailyPairs({ start: '2020-01-01', measured: [], modelled: [] })).toEqual([]);
  });
});

/* ── monthlyPairsFromDaily ─────────────────────────────────────────────── */

describe('monthlyPairsFromDaily', () => {
  function fullMonthPairs(ym, a, b) {
    const n = daysInMonth(ym);
    return Array.from({ length: n }, (_, i) => ({
      key: `${ym}-${String(i + 1).padStart(2, '0')}`, a, b,
    }));
  }

  it('averages both sides over common days', () => {
    const pairs = fullMonthPairs('2020-04', 6, 4);
    const monthly = monthlyPairsFromDaily(pairs);
    expect(monthly).toEqual([{ key: '2020-04', a: 6, b: 4, n: 30 }]);
  });

  it('drops months below the coverage fraction', () => {
    const pairs = fullMonthPairs('2020-01', 5, 5).slice(0, 20); // 20/31 < 0.8
    expect(monthlyPairsFromDaily(pairs)).toEqual([]);
  });

  it('keeps months at or above the coverage fraction', () => {
    const pairs = fullMonthPairs('2020-04', 5, 5).slice(0, 24); // 24/30 = 0.8
    expect(monthlyPairsFromDaily(pairs)).toHaveLength(1);
  });

  it('sorts output by month', () => {
    const pairs = [...fullMonthPairs('2020-02', 1, 1), ...fullMonthPairs('2019-12', 2, 2)];
    expect(monthlyPairsFromDaily(pairs).map((p) => p.key)).toEqual(['2019-12', '2020-02']);
  });
});

/* ── monthlyPairsFromGhcn ──────────────────────────────────────────────── */

describe('monthlyPairsFromGhcn', () => {
  const monthly = { start: '1940-01', modelled: [5.0, 6.0, null, 8.0] };

  it('pairs GHCNm hundredths with modelled °C on matching months', () => {
    const records = [{ year: 1940, months: [550, null, 700, 850, ...Array(8).fill(null)] }];
    expect(monthlyPairsFromGhcn(records, monthly)).toEqual([
      { key: '1940-01', a: 5.5, b: 5.0 },
      { key: '1940-04', a: 8.5, b: 8.0 },
    ]);
  });

  it('ignores station months outside the modelled range', () => {
    const records = [{ year: 1939, months: Array(12).fill(100) }];
    expect(monthlyPairsFromGhcn(records, monthly)).toEqual([]);
  });
});

/* ── annual / seasonal aggregation ─────────────────────────────────────── */

function yearOfMonthly(year, a, b) {
  return Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`, a, b,
  }));
}

describe('monthlyAnomalies', () => {
  const baseline = { start: 2001, end: 2002 };

  it('removes the per-calendar-month climatology from each series', () => {
    // Two baseline years: Jan a=[10,20]→clim 15, b=[3,7]→clim 5; a later year sees
    // its own value minus that climatology, per series independently.
    const pairs = [
      { key: '2001-01', a: 10, b: 3 },
      { key: '2002-01', a: 20, b: 7 },
      { key: '2010-01', a: 18, b: 6 },
    ];
    expect(monthlyAnomalies(pairs, baseline)).toEqual([
      { key: '2001-01', a: -5, b: -2 },
      { key: '2002-01', a: 5, b: 2 },
      { key: '2010-01', a: 3, b: 1 },
    ]);
  });

  it('subtracts the seasonal cycle by working per calendar month', () => {
    // Jan clim 0, Jul clim 100 (a); the raw seasonal swing is gone from anomalies.
    const pairs = [
      { key: '2001-01', a: 0, b: 0 },
      { key: '2001-07', a: 100, b: 50 },
    ];
    expect(monthlyAnomalies(pairs, baseline)).toEqual([
      { key: '2001-01', a: 0, b: 0 },
      { key: '2001-07', a: 0, b: 0 },
    ]);
  });

  it('drops months with no data inside the baseline window', () => {
    const pairs = [{ key: '1995-06', a: 12, b: 4 }];
    expect(monthlyAnomalies(pairs, baseline)).toEqual([]);
  });

  it('defaults to the 1991–2020 WMO normal', () => {
    expect(ANOMALY_BASELINE).toEqual({ start: 1991, end: 2020 });
  });
});

describe('annualPairsFromMonthly', () => {
  it('requires all 12 months', () => {
    const pairs = yearOfMonthly(2000, 3, 1).slice(0, 11);
    expect(annualPairsFromMonthly(pairs)).toEqual([]);
  });

  it('averages a full year', () => {
    expect(annualPairsFromMonthly(yearOfMonthly(2000, 3, 1))).toEqual([
      { key: '2000', a: 3, b: 1 },
    ]);
  });
});

describe('seasonalPairsFromMonthly', () => {
  it('assigns December to the following DJF and requires 3 months', () => {
    const pairs = [
      { key: '1999-12', a: 1, b: 0 },
      { key: '2000-01', a: 2, b: 0 },
      { key: '2000-02', a: 3, b: 0 },
    ];
    expect(seasonalPairsFromMonthly(pairs)).toEqual([
      { key: '2000-DJF', a: 2, b: 0 },
    ]);
  });

  it('drops incomplete seasons', () => {
    const pairs = [
      { key: '2000-06', a: 1, b: 0 },
      { key: '2000-07', a: 2, b: 0 },
    ];
    expect(seasonalPairsFromMonthly(pairs)).toEqual([]);
  });

  it('orders seasons within a year', () => {
    const pairs = yearOfMonthly(2000, 1, 0).concat([{ key: '1999-12', a: 1, b: 0 }]);
    const keys = seasonalPairsFromMonthly(pairs).map((p) => p.key);
    expect(keys).toEqual(['2000-DJF', '2000-MAM', '2000-JJA', '2000-SON']);
  });
});

/* ── quantile / band / transfer ────────────────────────────────────────── */

describe('quantile', () => {
  it('interpolates linearly (R type 7)', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
  });

  it('handles extremes and empty input', () => {
    expect(quantile([3, 1, 2], 0)).toBe(1);
    expect(quantile([3, 1, 2], 1)).toBe(3);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('empiricalBand', () => {
  const diffs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it('returns central quantiles at the requested coverage', () => {
    const band = empiricalBand(diffs, 0.9);
    expect(band.lo).toBeCloseTo(5.95, 10);
    expect(band.hi).toBeCloseTo(95.05, 10);
    expect(band.n).toBe(100);
    expect(band.coverage).toBe(0.9);
  });

  it('refuses to build a band on too few differences', () => {
    expect(empiricalBand(diffs.slice(0, MIN_DIFFS_FOR_BAND - 1), 0.9)).toBeNull();
    expect(empiricalBand(diffs.slice(0, MIN_DIFFS_FOR_BAND), 0.9)).not.toBeNull();
  });
});

describe('transferCoverage', () => {
  const band = { lo: -1, hi: 1 };

  it('counts measured values inside modelled + band', () => {
    const pairs = [
      { key: 'x', a: 10.5, b: 10 },  // inside
      { key: 'y', a: 12, b: 10 },    // outside
      { key: 'z', a: 9, b: 10 },     // inside (boundary)
    ];
    expect(transferCoverage(pairs, band)).toEqual({ inside: 2, n: 3, fraction: 2 / 3 });
  });

  it('returns null without pairs or band', () => {
    expect(transferCoverage([], band)).toBeNull();
    expect(transferCoverage([{ key: 'x', a: 1, b: 1 }], null)).toBeNull();
  });
});

describe('summarizeDiffs', () => {
  it('reports n, mean, and median', () => {
    expect(summarizeDiffs([1, 2, 6])).toEqual({ n: 3, mean: 3, median: 2 });
  });

  it('returns null for empty input', () => {
    expect(summarizeDiffs([])).toBeNull();
  });
});

/* ── differences convention ────────────────────────────────────────────── */

describe('differences', () => {
  it('is measured minus modelled', () => {
    expect(differences([{ key: 'x', a: 3, b: 5 }])).toEqual([-2]);
  });
});
