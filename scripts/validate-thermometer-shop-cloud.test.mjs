// Tests for the pure pieces of the thermometer-shop USCRN validation.
// The data-dependent main() is exercised manually (npm run
// validate:thermometer-shop) — these cover the parsing, classification,
// and metric logic it relies on.
import { describe, it, expect } from 'vitest';
import {
  dayOfYearFromYmd,
  sinElev,
  loadStationDays,
  classifyDay,
  daytimeMask,
  metrics,
} from './validate-thermometer-shop-cloud.mjs';

const ST = { latDeg: 43.27, lonDeg: -124.31, tzMeridian: -120 };
const S0 = 1361 * 0.75; // clear-sky envelope the clearness index divides by

describe('dayOfYearFromYmd', () => {
  it('handles year boundaries and leap days', () => {
    expect(dayOfYearFromYmd('20240101')).toBe(1);
    expect(dayOfYearFromYmd('20240301')).toBe(61); // 2024 is a leap year
    expect(dayOfYearFromYmd('20241231')).toBe(366);
    expect(dayOfYearFromYmd('20230301')).toBe(60);
  });
});

describe('loadStationDays', () => {
  // Rows in USCRN subhourly01 layout: fields 4/5 are LST date/time,
  // 9 air temp, 11 solar, 12 SR flag, 22 wind, 23 wind flag (1-indexed).
  // Timestamps are period-ENDING: 0405 covers 04:00–04:05.
  const rows = [
    '12345 20240615 1205 20240615 0405 2.514 -124.32 43.27 12.3 0.0 5 0 13.9 C 0 88 0 0.11 14.9 1103 0 1.2 0',
    '12345 20240615 1210 20240615 0410 2.514 -124.32 43.27 -9999.0 0.0 -99999 3 14.0 C 0 88 0 0.11 14.9 1103 0 -9999.0 3',
    '12345 20240616 0800 20240616 0000 2.514 -124.32 43.27 9.9 0.0 0 0 13.9 C 0 88 0 0.11 14.9 1103 0 0.8 0',
  ].join('\n');

  it('bins period-ending stamps, rolls 0000 to the previous day, drops sentinels/flagged', () => {
    const days = loadStationDays(rows);
    const rec = days.get('20240615');
    const idx0405 = (4 * 60 + 5) / 5 - 1; // 04:05 stamp = bin starting 04:00
    expect(rec.t[idx0405]).toBeCloseTo(12.3);
    expect(rec.ghi[idx0405]).toBe(5);
    expect(rec.wind[idx0405]).toBeCloseTo(1.2);
    const idx0410 = idx0405 + 1;
    expect(Number.isNaN(rec.t[idx0410])).toBe(true); // -9999 sentinel
    expect(Number.isNaN(rec.ghi[idx0410])).toBe(true); // SR_FLAG 3
    expect(Number.isNaN(rec.wind[idx0410])).toBe(true); // WIND_FLAG 3
    // The 20240616 00:00 stamp is the mean over 23:55–24:00 of the 15th.
    expect(rec.t[287]).toBeCloseTo(9.9);
    expect(days.get('20240616')).toBeUndefined();
  });
});

// Build a synthetic full day at a given clearness profile: k may be a
// constant or a function of bin index.
function synthDay(st, doy, k) {
  const rec = {
    t: new Float64Array(288).fill(15),
    ghi: new Float64Array(288).fill(NaN),
    wind: new Float64Array(288).fill(2),
  };
  for (let i = 0; i < 288; i++) {
    const lstHour = (i * 5) / 60 + 5 / 120;
    const solarHour = lstHour + (st.lonDeg - st.tzMeridian) / 15;
    const se = sinElev(st.latDeg, doy, solarHour);
    rec.ghi[i] = Math.max(0, S0 * se * (typeof k === 'function' ? k(i) : k));
  }
  return rec;
}

describe('classifyDay', () => {
  it('classifies a steady near-envelope day as clear with c≈0', () => {
    const info = classifyDay(ST, '20240615', synthDay(ST, 167, 0.97));
    expect(info.cls).toBe('clear');
    expect(info.cSunshine).toBe(0);
  });

  it('classifies a dim steady day as overcast with c≈1', () => {
    const info = classifyDay(ST, '20240615', synthDay(ST, 167, 0.2));
    expect(info.cls).toBe('overcast');
    expect(info.cSunshine).toBe(1);
  });

  it('classifies an alternating bright/dim day as broken with intermediate c', () => {
    const info = classifyDay(ST, '20240615', synthDay(ST, 167, (i) => (i % 2 ? 1.0 : 0.35)));
    expect(info.cls).toBe('broken');
    expect(info.cSunshine).toBeGreaterThan(0.3);
    expect(info.cSunshine).toBeLessThan(0.7);
  });

  it('rejects days with too many missing temperatures', () => {
    const rec = synthDay(ST, 167, 0.97);
    for (let i = 0; i < 10; i++) rec.t[i] = NaN;
    expect(classifyDay(ST, '20240615', rec)).toBeNull();
  });
});

describe('metrics', () => {
  const doy = 167;
  const mask = daytimeMask(ST, doy);

  it('is ~zero for a constant series', () => {
    const m = metrics(new Array(288).fill(10), mask);
    expect(m.dtSd).toBe(0);
    expect(m.residSd).toBe(0);
  });

  it('grows with step-to-step wiggle and registers spikes in p95', () => {
    const calm = new Array(288).fill(0).map((_, i) => 15 + 0.05 * (i % 2));
    const spiky = new Array(288).fill(0).map((_, i) => 15 + 0.4 * (i % 2));
    const mCalm = metrics(calm, mask);
    const mSpiky = metrics(spiky, mask);
    expect(mSpiky.dtSd).toBeGreaterThan(mCalm.dtSd * 4);
    expect(mSpiky.dtP95).toBeCloseTo(0.4, 6);
    expect(mSpiky.residSd).toBeGreaterThan(mCalm.residSd * 4);
  });

  it('ignores nighttime samples and survives gaps', () => {
    const series = new Array(288).fill(12);
    for (let i = 0; i < 288; i++) if (!mask[i]) series[i] = 999; // night garbage
    series[150] = NaN; // one daytime gap
    const m = metrics(series, mask);
    expect(m.dtSd).toBe(0); // night values never entered
  });

  it('returns null when too few daytime pairs exist', () => {
    expect(metrics(new Array(288).fill(10), new Array(288).fill(false))).toBeNull();
  });
});
