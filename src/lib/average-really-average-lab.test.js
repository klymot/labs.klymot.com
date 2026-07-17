import { describe, expect, it } from 'vitest';
import {
  STRATEGIES,
  annualGapSeries,
  dailyGaps,
  monthOfYearClimatology,
  fPValue,
  monthlyGapSeries,
  oneWayAnova,
  predictCorrection,
  rmse,
  runHoldout,
  scoreStrategy,
  splitByFraction,
  trainStats,
} from './average-really-average-lab.js';

/* ── oneWayAnova ───────────────────────────────────────────────────────── */

describe('oneWayAnova', () => {
  it('returns null with fewer than two usable groups', () => {
    expect(oneWayAnova([])).toBeNull();
    expect(oneWayAnova([{ n: 10, mean: 1, var: 0.5 }])).toBeNull();
    expect(oneWayAnova([{ n: 1, mean: 1, var: null }, { n: 1, mean: 2, var: null }])).toBeNull();
  });

  it('gives F near 0 when group means are identical', () => {
    const a = oneWayAnova([
      { n: 30, mean: 0.2, var: 0.5 },
      { n: 30, mean: 0.2, var: 0.5 },
      { n: 30, mean: 0.2, var: 0.5 },
    ]);
    expect(a.k).toBe(3);
    expect(a.F).toBeCloseTo(0, 6);
    expect(a.meanSpread).toBeCloseTo(0, 6);
  });

  it('gives a large F when means differ far more than within-group spread', () => {
    const a = oneWayAnova([
      { n: 100, mean: -0.3, var: 0.01 },
      { n: 100, mean: 0.0, var: 0.01 },
      { n: 100, mean: 0.4, var: 0.01 },
    ]);
    expect(a.F).toBeGreaterThan(100);
    expect(a.meanSpread).toBeGreaterThan(0.3);
    expect(a.withinSd).toBeCloseTo(0.1, 6);
    expect(a.dfB).toBe(2);
    expect(a.dfW).toBe(297);
  });

  it('matches a hand-computed F for a simple balanced case', () => {
    // n=2 each, means 1/2/3, var=2 each → SSb=4 (MSb=2), SSw=6 (MSw=2), F=1
    const a = oneWayAnova([
      { n: 2, mean: 1, var: 2 },
      { n: 2, mean: 2, var: 2 },
      { n: 2, mean: 3, var: 2 },
    ]);
    expect(a.F).toBeCloseTo(1, 6);
    expect(a.dfB).toBe(2);
    expect(a.dfW).toBe(3);
  });
});

/* ── fPValue ───────────────────────────────────────────────────────────── */

describe('fPValue', () => {
  it('is ~0.5 at F=1 with equal degrees of freedom', () => {
    expect(fPValue(1, 10, 10)).toBeCloseTo(0.5, 2);
    expect(fPValue(1, 20, 20)).toBeCloseTo(0.5, 2);
  });

  it('shrinks toward 0 as F grows and toward 1 as F→0', () => {
    expect(fPValue(50, 2, 100)).toBeLessThan(0.001);
    expect(fPValue(0.01, 2, 100)).toBeGreaterThan(0.9);
  });

  it('is monotonically decreasing in F', () => {
    const a = fPValue(2, 3, 60);
    const b = fPValue(5, 3, 60);
    const c = fPValue(10, 3, 60);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('matches a known F critical value (F(2,10)=4.10 → p≈0.05)', () => {
    expect(fPValue(4.10, 2, 10)).toBeCloseTo(0.05, 2);
  });

  it('guards degenerate input', () => {
    expect(fPValue(0, 2, 10)).toBe(1);
    expect(fPValue(-1, 2, 10)).toBe(1);
  });
});

/* ── dailyGaps ─────────────────────────────────────────────────────────── */

describe('dailyGaps', () => {
  it('computes gap = mid − avg and keeps the day key', () => {
    const out = dailyGaps([
      { d: '2020-01-01', tmax: 10, tmin: 0, mid: 5, avg: 4.5 },
      { d: '2020-01-02', tmax: 8, tmin: 2, mid: 5, avg: 5.2 },
    ]);
    expect(out).toEqual([
      { d: '2020-01-01', mid: 5, avg: 4.5, gap: 0.5 },
      { d: '2020-01-02', mid: 5, avg: 5.2, gap: expect.closeTo(-0.2, 10) },
    ]);
  });

  it('drops days missing either mid or avg', () => {
    const out = dailyGaps([
      { d: '2020-01-01', mid: null, avg: 4 },
      { d: '2020-01-02', mid: 5, avg: null },
      { d: '2020-01-03', mid: 5, avg: 4 },
    ]);
    expect(out.map((p) => p.d)).toEqual(['2020-01-03']);
  });

  it('handles empty / missing input', () => {
    expect(dailyGaps([])).toEqual([]);
    expect(dailyGaps(undefined)).toEqual([]);
  });
});

/* ── monthlyGapSeries ──────────────────────────────────────────────────── */

describe('monthlyGapSeries', () => {
  it('pairs mid/avg by month into gaps with parsed year and calendar month', () => {
    const monthly = {
      start: '2020-01',
      months: ['2020-01', '2020-02', '2020-03'],
      mid: [5, 6, null],
      avg: [4, 6.5, 3],
      n: [30, 28, 31],
    };
    expect(monthlyGapSeries(monthly)).toEqual([
      { month: '2020-01', year: 2020, mon: 1, gap: 1, n: 30 },
      { month: '2020-02', year: 2020, mon: 2, gap: expect.closeTo(-0.5, 10), n: 28 },
    ]);
  });

  it('returns empty for missing monthly block', () => {
    expect(monthlyGapSeries(null)).toEqual([]);
    expect(monthlyGapSeries({})).toEqual([]);
  });
});

/* ── monthOfYearClimatology ────────────────────────────────────────────── */

describe('monthOfYearClimatology', () => {
  const series = [
    { month: '2001-01', year: 2001, mon: 1, gap: 0 },
    { month: '2002-01', year: 2002, mon: 1, gap: 2 },
    { month: '2001-07', year: 2001, mon: 7, gap: -1 },
  ];

  it('averages the gap per calendar month over all years', () => {
    const { byMonth } = monthOfYearClimatology(series);
    expect(byMonth).toHaveLength(12);
    expect(byMonth[0]).toEqual({ mon: 1, mean: 1, n: 2 }); // (0+2)/2
    expect(byMonth[6]).toEqual({ mon: 7, mean: -1, n: 1 });
    expect(byMonth[3]).toEqual({ mon: 4, mean: null, n: 0 }); // April absent
  });

  it('returns per-year traces indexed by calendar month', () => {
    const { traces } = monthOfYearClimatology(series);
    expect(traces.map((t) => t.year)).toEqual([2001, 2002]);
    expect(traces[0].values[0]).toBe(0);
    expect(traces[0].values[6]).toBe(-1);
    expect(traces[0].values[1]).toBeNull();
    expect(traces[1].values[0]).toBe(2);
  });
});

/* ── annualGapSeries ───────────────────────────────────────────────────── */

describe('annualGapSeries', () => {
  const series = [
    { month: '2001-01', year: 2001, mon: 1, gap: 0 },
    { month: '2001-02', year: 2001, mon: 2, gap: 2 },
    { month: '2002-01', year: 2002, mon: 1, gap: 5 },
  ];

  it('averages the monthly gaps within each calendar year', () => {
    expect(annualGapSeries(series)).toEqual([
      { year: 2001, gap: 1, n: 2 },
      { year: 2002, gap: 5, n: 1 },
    ]);
  });

  it('drops years below the minimum month count', () => {
    expect(annualGapSeries(series, 2)).toEqual([
      { year: 2001, gap: 1, n: 2 },
    ]);
  });
});

/* ── splitByFraction ───────────────────────────────────────────────────── */

describe('splitByFraction', () => {
  const series = Array.from({ length: 10 }, (_, i) => ({
    month: `20${String(10 + i).padStart(2, '0')}-01`, year: 2010 + i, mon: 1, gap: i,
  }));

  it('holds back the tail by default, sorted chronologically', () => {
    const { train, test } = splitByFraction(series, 0.3, 'tail');
    expect(train).toHaveLength(7);
    expect(test).toHaveLength(3);
    expect(test.map((p) => p.gap)).toEqual([7, 8, 9]);
  });

  it('can hold back the head instead', () => {
    const { train, test } = splitByFraction(series, 0.2, 'head');
    expect(test.map((p) => p.gap)).toEqual([0, 1]);
    expect(train.map((p) => p.gap)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('always holds back at least one month', () => {
    const { test } = splitByFraction(series.slice(0, 3), 0.01);
    expect(test).toHaveLength(1);
  });
});

/* ── trainStats / predictCorrection ────────────────────────────────────── */

describe('trainStats', () => {
  it('reports the overall mean and per-calendar-month climatology', () => {
    const stats = trainStats([
      { mon: 1, gap: 0 }, { mon: 1, gap: 2 }, { mon: 7, gap: -3 },
    ]);
    expect(stats.mean).toBeCloseTo(-1 / 3, 10);
    expect(stats.climatology[0]).toBe(1);   // Jan
    expect(stats.climatology[6]).toBe(-3);  // Jul
    expect(stats.climatology[3]).toBeNull(); // Apr absent
    expect(stats.n).toBe(3);
  });

  it('defaults the mean to 0 on empty training data', () => {
    expect(trainStats([]).mean).toBe(0);
  });
});

describe('predictCorrection', () => {
  const stats = { mean: 1.5, climatology: [0.5, null, 2, ...Array(9).fill(null)] };

  it('zero strategy always predicts no correction', () => {
    expect(predictCorrection('zero', stats, 1)).toBe(0);
    expect(predictCorrection('zero', stats, 7)).toBe(0);
  });

  it('constant strategy predicts the training mean', () => {
    expect(predictCorrection('constant', stats, 5)).toBe(1.5);
  });

  it('seasonal strategy uses the calendar-month value, falling back to the mean', () => {
    expect(predictCorrection('seasonal', stats, 1)).toBe(0.5);
    expect(predictCorrection('seasonal', stats, 2)).toBe(1.5); // Feb absent → mean
  });
});

/* ── rmse / scoreStrategy ──────────────────────────────────────────────── */

describe('rmse', () => {
  it('is the root mean square of the residuals', () => {
    expect(rmse([3, 4])).toBeCloseTo(Math.sqrt((9 + 16) / 2), 10);
  });
  it('is null for empty input', () => {
    expect(rmse([])).toBeNull();
  });
});

describe('scoreStrategy', () => {
  const train = [
    { mon: 1, gap: 1 }, { mon: 1, gap: 1 }, { mon: 2, gap: 3 }, { mon: 2, gap: 3 },
  ];
  const test = [
    { mon: 1, gap: 1 }, { mon: 2, gap: 3 },
  ];

  it('zero leaves the full gap as the residual', () => {
    const r = scoreStrategy(train, test, 'zero');
    // residuals = [1, 3] → rmse = sqrt((1+9)/2)
    expect(r.rmse).toBeCloseTo(Math.sqrt(5), 10);
    expect(r.n).toBe(2);
  });

  it('a perfect seasonal fit drives the leftover error to zero here', () => {
    // training climatology: Jan=1, Feb=3 exactly matches the test gaps
    const r = scoreStrategy(train, test, 'seasonal');
    expect(r.rmse).toBeCloseTo(0, 10);
  });

  it('constant leaves the deviation from the training mean', () => {
    // mean = 2; residuals = [1-2, 3-2] = [-1, 1] → rmse = 1
    const r = scoreStrategy(train, test, 'constant');
    expect(r.rmse).toBeCloseTo(1, 10);
  });
});

/* ── runHoldout ────────────────────────────────────────────────────────── */

describe('runHoldout', () => {
  const series = Array.from({ length: 12 }, (_, i) => ({
    month: `2010-${String(i + 1).padStart(2, '0')}`, year: 2010, mon: i + 1, gap: i,
  })).concat(Array.from({ length: 12 }, (_, i) => ({
    month: `2011-${String(i + 1).padStart(2, '0')}`, year: 2011, mon: i + 1, gap: i,
  })));

  it('scores all three strategies on the held-out block', () => {
    const out = runHoldout(series, 0.5, 'tail');
    expect(Object.keys(out.results).sort()).toEqual([...STRATEGIES].sort());
    expect(out.train).toHaveLength(12);
    expect(out.test).toHaveLength(12);
    // The gap only depends on calendar month, so a seasonal fit on year 1
    // predicts year 2 exactly: zero leftover.
    expect(out.results.seasonal.rmse).toBeCloseTo(0, 10);
    // Zero leaves the full gaps 0..11.
    expect(out.results.zero.rmse).toBeGreaterThan(out.results.constant.rmse);
  });
});
