import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  hashString,
  wallAzimuthFactor,
  WIND_REGIMES,
  getWindRegime,
  solarDeclinationDeg,
  solarPosition,
  seasonalBaselineC,
  cloudTransmission,
  simulateDay,
  runCartItem,
  runCheckout,
  getInstrument,
  getExposure,
  CATALOGUE,
  EXPOSURES,
  LOCATIONS,
  STEPS_PER_DAY,
  DT_SECONDS,
} from './thermometer-shop-model.js';

describe('seeded RNG', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });

  it('hashString is stable and differs across strings', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('solar geometry', () => {
  it('declination stays within ±23.44°', () => {
    for (let d = 1; d <= 365; d += 7) {
      expect(Math.abs(solarDeclinationDeg(d))).toBeLessThanOrEqual(23.44 + 1e-9);
    }
  });

  it('equinox day length is about 12 h at mid-latitude', () => {
    // Day 80 ≈ March equinox. Count hours with the sun up at 40° N.
    let upHours = 0;
    for (let h = 0; h < 24; h += 0.05) {
      if (solarPosition(40, 80, h).elevationDeg > 0) upHours += 0.05;
    }
    expect(upHours).toBeGreaterThan(11.4);
    expect(upHours).toBeLessThan(12.6);
  });

  it('78° N has polar night in late December and midnight sun in late June', () => {
    let maxElevDec = -Infinity;
    let minElevJun = Infinity;
    for (let h = 0; h < 24; h += 0.1) {
      maxElevDec = Math.max(maxElevDec, solarPosition(78, 355, h).elevationDeg);
      minElevJun = Math.min(minElevJun, solarPosition(78, 172, h).elevationDeg);
    }
    expect(maxElevDec).toBeLessThan(0);
    expect(minElevJun).toBeGreaterThan(0);
  });

  it('noon sun is due south at 40° N and due north at 34° S', () => {
    const north = solarPosition(40, 172, 12);
    expect(Math.abs(north.azimuthDeg - 180)).toBeLessThan(5);
    const south = solarPosition(-34, 172, 12);
    const azFromNorth = Math.min(south.azimuthDeg, 360 - south.azimuthDeg);
    expect(azFromNorth).toBeLessThan(5);
  });

  it('the poleward wall faces north in the north and south in the south', () => {
    // Northern hemisphere: wall normal points north — midday sun (az 180)
    // is behind it, a northern-quadrant sun (az 0) hits it face-on.
    expect(wallAzimuthFactor(53, 180)).toBeLessThan(0);
    expect(wallAzimuthFactor(53, 0)).toBeCloseTo(1, 6);
    // Southern hemisphere: wall normal points south — midday sun (az 0,
    // sun to the north) is behind it, a southern sun (az 180) face-on.
    expect(wallAzimuthFactor(-34, 0)).toBeLessThan(0);
    expect(wallAzimuthFactor(-34, 180)).toBeCloseTo(1, 6);
  });

  it('high-latitude midsummer sun rises in the north-east (into a north wall)', () => {
    // 64° N, late June, 03:30 local solar time: sun already up, azimuth in
    // the north-eastern quadrant — the geometry behind wall exposure sun.
    const p = solarPosition(64, 172, 3.5);
    expect(p.elevationDeg).toBeGreaterThan(0);
    expect(p.azimuthDeg).toBeLessThan(90);
  });
});

describe('seasonal baseline', () => {
  it('is warmer at the equator than at the poles', () => {
    expect(seasonalBaselineC(0, 100)).toBeGreaterThan(seasonalBaselineC(75, 100));
    expect(seasonalBaselineC(0, 100)).toBeGreaterThan(seasonalBaselineC(-75, 100));
  });

  it('flips seasons between hemispheres', () => {
    const julNorth = seasonalBaselineC(50, 200);
    const janNorth = seasonalBaselineC(50, 20);
    const julSouth = seasonalBaselineC(-50, 200);
    const janSouth = seasonalBaselineC(-50, 20);
    expect(julNorth).toBeGreaterThan(janNorth);
    expect(janSouth).toBeGreaterThan(julSouth);
  });
});

describe('cloud transmission', () => {
  it('is 1 with no cloud, minimum under full cloud, monotone in between', () => {
    expect(cloudTransmission(0)).toBe(1);
    expect(cloudTransmission(1)).toBeCloseTo(0.25, 6);
    let prev = cloudTransmission(0);
    for (let c = 0.1; c <= 1; c += 0.1) {
      const t = cloudTransmission(c);
      expect(t).toBeLessThan(prev);
      prev = t;
    }
  });
});

describe('simulateDay', () => {
  const base = { latDeg: 45, dayOfYear: 172, cloudFraction: 0.2, seed: 12345 };

  it('is deterministic for the same inputs', () => {
    const a = simulateDay(base);
    const b = simulateDay(base);
    expect(Array.from(a.airC.slice(0, 50))).toEqual(Array.from(b.airC.slice(0, 50)));
    expect(a.trueMeanC).toBe(b.trueMeanC);
  });

  it('differs for a different seed', () => {
    const a = simulateDay(base);
    const b = simulateDay({ ...base, seed: 54321 });
    expect(a.trueMeanC).not.toBe(b.trueMeanC);
  });

  it('returns one full day of samples with true stats ordered', () => {
    const d = simulateDay(base);
    expect(d.airC.length).toBe(STEPS_PER_DAY);
    expect(d.trueMinC).toBeLessThan(d.trueMeanC);
    expect(d.trueMeanC).toBeLessThan(d.trueMaxC);
    expect(d.trueMedianC).toBeGreaterThan(d.trueMinC);
    expect(d.trueMedianC).toBeLessThan(d.trueMaxC);
  });

  it('produces a plausible clear-sky midlatitude diurnal range', () => {
    const d = simulateDay({ ...base, cloudFraction: 0 });
    const range = d.trueMaxC - d.trueMinC;
    expect(range).toBeGreaterThan(5);
    expect(range).toBeLessThan(18);
  });

  it('full overcast shrinks the diurnal range relative to clear sky', () => {
    const clear = simulateDay({ ...base, cloudFraction: 0 });
    const overcast = simulateDay({ ...base, cloudFraction: 1 });
    expect(overcast.trueMaxC - overcast.trueMinC).toBeLessThan(
      clear.trueMaxC - clear.trueMinC
    );
  });

  it('has zero irradiance through polar night', () => {
    const d = simulateDay({ latDeg: 78, dayOfYear: 355, cloudFraction: 0, seed: 7 });
    let maxGhi = 0;
    for (let i = 0; i < d.ghi.length; i++) maxGhi = Math.max(maxGhi, d.ghi[i]);
    expect(maxGhi).toBe(0);
  });
});

describe('exposures and instruments', () => {
  const day = simulateDay({ latDeg: 45, dayOfYear: 172, cloudFraction: 0.3, seed: 99 });

  // A zero-tolerance clone lets tests compare mechanisms without the
  // manufacturing draw adding noise.
  function exact(instrument, overrides = {}) {
    return { ...instrument, toleranceC: 0, resolutionC: 0.001, ...overrides };
  }

  it('all catalogue/exposure ids resolve', () => {
    CATALOGUE.forEach((c) => expect(getInstrument(c.id)).toBe(c));
    EXPOSURES.forEach((e) => expect(getExposure(e.id)).toBe(e));
    expect(getInstrument('nope')).toBeNull();
  });

  it('locations span both hemispheres', () => {
    expect(LOCATIONS.some((l) => l.latDeg > 0)).toBe(true);
    expect(LOCATIONS.some((l) => l.latDeg < 0)).toBe(true);
  });

  it('recorded Tmax ≥ Tmin and midpoint is their mean', () => {
    CATALOGUE.forEach((inst) => {
      EXPOSURES.forEach((exp) => {
        const r = runCartItem(day, inst, exp, `k:${inst.id}:${exp.id}`);
        expect(r.recordedTmaxC).toBeGreaterThanOrEqual(r.recordedTminC);
        expect(r.midpointC).toBeCloseTo((r.recordedTmaxC + r.recordedTminC) / 2, 9);
      });
    });
  });

  it('recorded values land on the instrument resolution grid', () => {
    const inst = getInstrument('lig1780');
    const r = runCartItem(day, inst, getExposure('stevenson'), 'res-check');
    const remainder = Math.abs(r.recordedTmaxC / inst.resolutionC
      - Math.round(r.recordedTmaxC / inst.resolutionC));
    expect(remainder).toBeLessThan(1e-9);
  });

  it('the aspirated shield tracks the air more closely than the Stevenson screen', () => {
    const inst = exact(getInstrument('prtFast'));
    const asp = runCartItem(day, inst, getExposure('aspirated'), 'a');
    const stev = runCartItem(day, inst, getExposure('stevenson'), 'b');
    let rmsAsp = 0;
    let rmsStev = 0;
    for (let i = 0; i < day.airC.length; i++) {
      rmsAsp += (asp.instrSeries[i] - day.airC[i]) ** 2;
      rmsStev += (stev.instrSeries[i] - day.airC[i]) ** 2;
    }
    expect(Math.sqrt(rmsAsp)).toBeLessThan(Math.sqrt(rmsStev));
  });

  it('longer averaging blocks cannot record a higher Tmax than denser sampling of the same sensor', () => {
    // Same sensor, same exposure, zero tolerance: every-step spot samples
    // bound the block-mean extremes mathematically.
    const spotAll = exact(getInstrument('prtFast'), {
      registration: 'spot',
      sampleSeconds: DT_SECONDS,
    });
    const avg5 = exact(getInstrument('prtUscrn'), { sampleSeconds: DT_SECONDS });
    const exp = getExposure('aspirated');
    const rSpot = runCartItem(day, spotAll, exp, 'same');
    const rAvg = runCartItem(day, avg5, exp, 'same');
    expect(rAvg.recordedTmaxC).toBeLessThanOrEqual(rSpot.recordedTmaxC + 1e-9);
    expect(rAvg.recordedTminC).toBeGreaterThanOrEqual(rSpot.recordedTminC - 1e-9);
  });

  it('index friction can only narrow the registered extremes, never widen them', () => {
    const free = exact(getInstrument('lig1780'), { stictionC: 0 });
    const sticky = exact(getInstrument('lig1780'));
    const exp = getExposure('stevenson');
    const rFree = runCartItem(day, free, exp, 'same');
    const rSticky = runCartItem(day, sticky, exp, 'same');
    expect(rSticky.recordedTmaxC).toBeLessThanOrEqual(rFree.recordedTmaxC + 1e-9);
    expect(rSticky.recordedTminC).toBeGreaterThanOrEqual(rFree.recordedTminC - 1e-9);
  });

  it('a slower sensor smooths turbulence: its series has lower variance about its own mean', () => {
    const fast = exact(getInstrument('prtFast'));
    const slow = exact(getInstrument('prtFast'), { tauSeconds: 600 });
    const exp = getExposure('aspirated');
    const rFast = runCartItem(day, fast, exp, 'same');
    const rSlow = runCartItem(day, slow, exp, 'same');
    function variance(series) {
      let m = 0;
      for (let i = 0; i < series.length; i++) m += series[i];
      m /= series.length;
      let v = 0;
      for (let i = 0; i < series.length; i++) v += (series[i] - m) ** 2;
      return v / series.length;
    }
    expect(variance(rSlow.instrSeries)).toBeLessThan(variance(rFast.instrSeries));
  });
});

describe('wind regimes', () => {
  it('span calm to hurricane with increasing speeds', () => {
    expect(WIND_REGIMES[0].id).toBe('calm');
    expect(WIND_REGIMES[WIND_REGIMES.length - 1].id).toBe('hurricane');
    for (let i = 1; i < WIND_REGIMES.length; i++) {
      expect(WIND_REGIMES[i].mps).toBeGreaterThan(WIND_REGIMES[i - 1].mps);
    }
    expect(getWindRegime('gale').mps).toBe(18);
    expect(getWindRegime('nope')).toBeNull();
  });

  it('carries a gusty wind series whose mean is near the regime mean', () => {
    const d = simulateDay({ latDeg: 45, dayOfYear: 172, cloudFraction: 0.2, seed: 5, windMps: 11, gustFrac: 0.45 });
    let sum = 0;
    let varies = false;
    for (let i = 0; i < d.windSeries.length; i++) {
      sum += d.windSeries[i];
      if (Math.abs(d.windSeries[i] - 11) > 0.5) varies = true;
    }
    const mean = sum / d.windSeries.length;
    expect(mean).toBeGreaterThan(8);
    expect(mean).toBeLessThan(14);
    expect(varies).toBe(true);
  });

  it('calm clear long nights dig a nocturnal minimum windy nights cannot', () => {
    // 45° N in winter (long night), clear sky: stable-night decoupling plus
    // T⁴ cooling against the clear sky should pull the calm night's minimum
    // well below the gale night's.
    const calm = simulateDay({ latDeg: 45, dayOfYear: 355, cloudFraction: 0, seed: 3, windMps: 0.4, gustFrac: 0.3 });
    const gale = simulateDay({ latDeg: 45, dayOfYear: 355, cloudFraction: 0, seed: 3, windMps: 18, gustFrac: 0.5 });
    expect(calm.trueMinC).toBeLessThan(gale.trueMinC - 2);
  });

  it('overcast lifts the calm clear-night minimum', () => {
    const clear = simulateDay({ latDeg: 45, dayOfYear: 355, cloudFraction: 0, seed: 3, windMps: 0.4, gustFrac: 0.3 });
    const overcast = simulateDay({ latDeg: 45, dayOfYear: 355, cloudFraction: 1, seed: 3, windMps: 0.4, gustFrac: 0.3 });
    expect(overcast.trueMinC).toBeGreaterThan(clear.trueMinC + 1);
  });

  it('the Stevenson screen tracks the air worse in calm than in a gale; the aspirated shield barely cares', () => {
    function rms(day, exposureId) {
      const inst = { ...getInstrument('prtFast'), toleranceC: 0, resolutionC: 0.001 };
      const r = runCartItem(day, inst, getExposure(exposureId), 'w');
      let s = 0;
      for (let i = 0; i < day.airC.length; i++) s += (r.instrSeries[i] - day.airC[i]) ** 2;
      return Math.sqrt(s / day.airC.length);
    }
    const base = { latDeg: 45, dayOfYear: 172, cloudFraction: 0.1, seed: 8 };
    const calm = simulateDay({ ...base, windMps: 0.4, gustFrac: 0.3 });
    const gale = simulateDay({ ...base, windMps: 18, gustFrac: 0.5 });
    expect(rms(calm, 'stevenson')).toBeGreaterThan(rms(gale, 'stevenson'));
    // The aspirated shield's calm-vs-gale change should be far smaller than
    // the screen's — the fan, not the wind, sets its behaviour.
    const stevensonChange = rms(calm, 'stevenson') - rms(gale, 'stevenson');
    const aspiratedChange = Math.abs(rms(calm, 'aspirated') - rms(gale, 'aspirated'));
    expect(aspiratedChange).toBeLessThan(stevensonChange / 2);
  });
});

describe('runCheckout', () => {
  const order = {
    latDeg: 53.3,
    dayOfYear: 200,
    cloudFraction: 0.5,
    seed: 2026,
    items: [
      { instrumentId: 'lig1880', exposureId: 'stevenson' },
      { instrumentId: 'prtUscrn', exposureId: 'aspirated' },
    ],
  };

  it('runs every item against the same day and is reproducible', () => {
    const a = runCheckout(order);
    const b = runCheckout(order);
    expect(a.results.length).toBe(2);
    expect(a.day.trueMeanC).toBe(b.day.trueMeanC);
    expect(a.results[0].recordedTmaxC).toBe(b.results[0].recordedTmaxC);
    expect(a.results[1].recordedTminC).toBe(b.results[1].recordedTminC);
  });

  it('gives two identical units in different slots different manufacturing draws', () => {
    const twin = runCheckout({
      ...order,
      items: [
        { instrumentId: 'lig1780', exposureId: 'northwall' },
        { instrumentId: 'lig1780', exposureId: 'northwall' },
      ],
    });
    expect(twin.results[0].calOffsetC).not.toBe(twin.results[1].calOffsetC);
  });

  it('re-rolling the weather keeps the same units when unitSeed is fixed', () => {
    const a = runCheckout({ ...order, unitSeed: 99 });
    const b = runCheckout({ ...order, seed: 31337, unitSeed: 99 });
    expect(b.day.trueMeanC).not.toBe(a.day.trueMeanC); // different weather…
    expect(b.results[0].calOffsetC).toBe(a.results[0].calOffsetC); // …same units
    expect(b.results[1].calOffsetC).toBe(a.results[1].calOffsetC);
    const c = runCheckout({ ...order, unitSeed: 100 });
    expect(c.results[0].calOffsetC).not.toBe(a.results[0].calOffsetC);
  });

  it('throws on unknown catalogue ids', () => {
    expect(() =>
      runCheckout({ ...order, items: [{ instrumentId: 'nope', exposureId: 'stevenson' }] })
    ).toThrow(/Unknown catalogue item/);
  });
});
