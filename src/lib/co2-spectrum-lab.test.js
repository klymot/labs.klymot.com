import { describe, it, expect } from 'vitest';
import {
  dequantize, columnSum, transmittance, combineTransmittance,
  emissionAltitude, temperatureAt, bandMean, interpLogX, sweepEarned, relativeAbsorption,
  solarShapeRelative,
  ppmFromSlider, sliderFromPpm, fmtPpm, PPM_MIN, PPM_MAX,
  planckBinFraction, absorptionByLayer, sampleAbsorbance, scaleForPeakAbsorbance, wavelengthToRgb, planckExitance,
} from './co2-spectrum-lab.js';

describe('dequantize', () => {
  it('maps code 0 to exactly zero', () => {
    const out = dequantize(new Uint16Array([0]), -10, 5);
    expect(out[0]).toBe(0);
  });
  it('maps code 1 to the lower bound and 65535 to the upper bound', () => {
    const out = dequantize(new Uint16Array([1, 65535]), -10, 5);
    expect(out[0]).toBeCloseTo(1e-10, 15);
    expect(out[1] / 1e5).toBeCloseTo(1, 5);
  });
  it('round-trips an interior value to within quantization tolerance', () => {
    // forward-quantize k = 1.0 with lo=-12, hi=4: code = round((0-lo)/(hi-lo)*65534)+1
    const lo = -12; const hi = 4;
    const code = Math.round(((0 - lo) / (hi - lo)) * 65534) + 1;
    const out = dequantize(new Uint16Array([code]), lo, hi);
    expect(Math.abs(Math.log10(out[0]))).toBeLessThan(1e-3);
  });
});

describe('columnSum / transmittance', () => {
  const nBins = 2; const nG = 2;
  const w = [0.5, 0.5];
  // two layers, k per (layer, bin, g)
  const k = Float32Array.from([
    1, 2, 0, 4, // layer 0: bin0 g=[1,2], bin1 g=[0,4]
    3, 4, 0, 6, // layer 1
  ]);

  it('sums layers per (bin, g)', () => {
    const s = columnSum(k, 2, nBins, nG);
    expect(Array.from(s)).toEqual([4, 6, 0, 10]);
  });

  it('computes the quadrature transmittance', () => {
    const s = columnSum(k, 2, nBins, nG);
    const t = transmittance(s, w, 0.5, nBins, nG);
    expect(t[0]).toBeCloseTo(0.5 * Math.exp(-2) + 0.5 * Math.exp(-3), 12);
    expect(t[1]).toBeCloseTo(0.5 * 1 + 0.5 * Math.exp(-5), 12);
  });

  it('is 1 at zero concentration and monotonically decreasing in vmr', () => {
    const s = columnSum(k, 2, nBins, nG);
    const t0 = transmittance(s, w, 0, nBins, nG);
    expect(t0[0]).toBeCloseTo(1, 12);
    let prev = 1;
    for (const vmr of [1e-6, 1e-4, 1e-2, 1]) {
      const t = transmittance(s, w, vmr, nBins, nG)[0];
      expect(t).toBeLessThan(prev);
      prev = t;
    }
  });

  it('saturates: doubling a large vmr barely moves an opaque bin', () => {
    const s = columnSum(k, 2, nBins, nG);
    const a = transmittance(s, w, 10, nBins, nG)[0];
    const b = transmittance(s, w, 20, nBins, nG)[0];
    expect(a).toBeLessThan(1e-8);
    expect(Math.abs(a - b)).toBeLessThan(1e-8);
  });
});

describe('combineTransmittance', () => {
  it('is the product (random overlap)', () => {
    const out = combineTransmittance(Float64Array.from([0.5, 1]), Float64Array.from([0.5, 0.25]));
    expect(Array.from(out)).toEqual([0.25, 0.25]);
  });
});

describe('emissionAltitude', () => {
  const nBins = 2; const nG = 1;
  const w = [1];
  const zMids = [500, 1500, 2500]; // three layers, bottom-up
  const zSurface = 0;

  it('reports the layer where cumulative OD from the top crosses 1', () => {
    // bin 0: k per layer (bottom-up) = [10, 0.6, 0.6] with vmr=1:
    // from top: 0.6 (no), +0.6=1.2 (crosses in middle layer, z=1500)
    // bin 1: all tiny -> never crosses -> NaN (the caller clips it to the surface)
    const k = Float32Array.from([
      10, 0.001, // layer 0 (bottom): bin0, bin1
      0.6, 0.001, // layer 1
      0.6, 0.001, // layer 2 (top)
    ]);
    const z = emissionAltitude(k, 3, nBins, nG, w, 1.0, zMids, zSurface);
    expect(z[0]).toBe(1500);
    expect(z[1]).toBeNaN();
  });

  it('moves upward when concentration rises', () => {
    const k = Float32Array.from([
      10, 0, // bottom
      0.6, 0,
      0.6, 0, // top
    ]);
    const lo = emissionAltitude(k, 3, nBins, nG, w, 1.0, zMids, zSurface);
    const hi = emissionAltitude(k, 3, nBins, nG, w, 2.0, zMids, zSurface);
    expect(hi[0]).toBeGreaterThanOrEqual(lo[0]);
    expect(hi[0]).toBe(2500); // 2*0.6 already crosses 1 in the top layer
  });
});

describe('temperatureAt', () => {
  const z = [0, 1000, 2000];
  const t = [288, 281.5, 275];
  it('interpolates linearly and clamps at the ends', () => {
    expect(temperatureAt(z, t, 500)).toBeCloseTo(284.75, 10);
    expect(temperatureAt(z, t, -50)).toBe(288);
    expect(temperatureAt(z, t, 99999)).toBe(275);
  });
});

describe('bandMean', () => {
  it('averages the bins inside the interval', () => {
    // nuMin 400, binWidth 2 -> bin b covers [400+2b, 402+2b]
    const series = Float64Array.from([1, 2, 3, 4]);
    expect(bandMean(series, 400, 2, 400, 404)).toBeCloseTo(1.5, 12);
    expect(bandMean(series, 400, 2, 404, 408)).toBeCloseTo(3.5, 12);
    expect(bandMean(series, 400, 2, 408, 408)).toBeNull();
  });
});

describe('interpLogX', () => {
  const xs = [10, 100, 1000];
  const ys = [1, 2, 3];
  it('is exact at the sample points and clamps outside', () => {
    expect(interpLogX(xs, ys, 100)).toBeCloseTo(2, 12);
    expect(interpLogX(xs, ys, 5)).toBe(1);
    expect(interpLogX(xs, ys, 99999)).toBe(3);
  });
  it('interpolates linearly in log x', () => {
    // sqrt(10*100) is halfway in log space
    expect(interpLogX(xs, ys, Math.sqrt(1000))).toBeCloseTo(1.5, 9);
  });
});

describe('sweepEarned', () => {
  it('needs both enough points and enough span', () => {
    expect(sweepEarned(new Set([10, 20, 30, 40, 50, 60, 70, 4000]))).toBe(true);
    expect(sweepEarned(new Set([10, 4000]))).toBe(false); // too few
    const narrow = new Set([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(sweepEarned(narrow)).toBe(false); // no span
  });
});

describe('solarShapeRelative', () => {
  it('normalizes to a max of 1 and rises toward the solar peak', () => {
    const nu = [500, 2000, 8000, 10000];
    const s = solarShapeRelative(nu);
    expect(Math.max(...s)).toBeCloseTo(1, 12);
    // Planck at 5772 K peaks near 10200 cm-1; shape must increase across this range
    expect(s[0]).toBeLessThan(s[1]);
    expect(s[1]).toBeLessThan(s[2]);
    expect(s[3]).toBe(1);
  });
});

describe('relativeAbsorption', () => {
  const ppm = [10, 100, 1000];
  const pct = [1, 2, 4];
  it('is exactly 1 at the reference itself', () => {
    expect(relativeAbsorption(ppm, pct, 100, 100)).toBeCloseTo(1, 12);
    expect(relativeAbsorption(ppm, pct, 37, 37)).toBeCloseTo(1, 12);
  });
  it('scales other points by the reference value', () => {
    expect(relativeAbsorption(ppm, pct, 100, 1000)).toBeCloseTo(2, 12);
    expect(relativeAbsorption(ppm, pct, 1000, 10)).toBeCloseTo(0.25, 12);
  });
  it('returns null for a zero/invalid reference value', () => {
    expect(relativeAbsorption(ppm, [0, 0, 0], 100, 1000)).toBeNull();
  });
});

describe('ppm slider mapping', () => {
  it('round-trips and spans the range', () => {
    expect(ppmFromSlider(0)).toBeCloseTo(PPM_MIN, 9);
    expect(ppmFromSlider(1)).toBeCloseTo(PPM_MAX, 9);
    for (const ppm of [10, 42, 420, 4999]) {
      expect(ppmFromSlider(sliderFromPpm(ppm))).toBeCloseTo(ppm, 6);
    }
  });
  it('formats sensibly', () => {
    expect(fmtPpm(419.7)).toBe('420');
    expect(fmtPpm(56.25)).toBe('56.3');
  });
});

describe('planckBinFraction', () => {
  it('sums to about 1 over a wide range', () => {
    const nu = Array.from({ length: 5000 }, (_, i) => 5 + i * 10);
    const f = planckBinFraction(nu, 10, 5772);
    const total = f.reduce((a, v) => a + v, 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.001);
  });
});

describe('absorptionByLayer', () => {
  // two layers, one bin, one g-point; CO2 only in the top layer, H2O only in the bottom
  const nL = 2; const nB = 1; const nG = 1; const w = [1];
  const kCo2 = new Float64Array([0, 1]);   // per unit vmr: bottom 0, top 1
  const kH2o = new Float64Array([1, 0]);   // bottom 1, top 0
  it('credits the first gas the beam meets with the undiminished beam', () => {
    const down = absorptionByLayer(kCo2, kH2o, nL, nB, nG, w, 1, [1], true);
    const up = absorptionByLayer(kCo2, kH2o, nL, nB, nG, w, 1, [1], false);
    const a = 1 - Math.exp(-1);
    expect(down.co2[1]).toBeCloseTo(a, 10);            // CO2 first, full beam
    expect(down.h2o[0]).toBeCloseTo(Math.exp(-1) * a, 10);
    expect(up.h2o[0]).toBeCloseTo(a, 10);              // H2O first, full beam
    expect(up.co2[1]).toBeCloseTo(Math.exp(-1) * a, 10);
  });
  it('gives the same column total in both directions', () => {
    const down = absorptionByLayer(kCo2, kH2o, nL, nB, nG, w, 1, [1], true);
    const up = absorptionByLayer(kCo2, kH2o, nL, nB, nG, w, 1, [1], false);
    const tot = (r) => r.co2[0] + r.co2[1] + r.h2o[0] + r.h2o[1];
    expect(tot(down)).toBeCloseTo(tot(up), 10);
    expect(tot(down)).toBeCloseTo(1 - Math.exp(-2), 10);
  });
});

describe('sampleAbsorbance / scaleForPeakAbsorbance', () => {
  // two bins, one g-point: k = [1, 0.1]
  const k = new Float64Array([1, 0.1]); const w = [1];
  it('is -log10 of the transmittance', () => {
    const a = sampleAbsorbance(k, w, 2, 2, 1);
    expect(a[0]).toBeCloseTo(2 / Math.LN10, 10);
    expect(a[1]).toBeCloseTo(0.2 / Math.LN10, 10);
  });
  it('finds the scale that puts the strongest bin at the target', () => {
    const sc = scaleForPeakAbsorbance(k, w, 0.1, 2, 1);
    const a = sampleAbsorbance(k, w, sc, 2, 1);
    expect(Math.max(a[0], a[1])).toBeCloseTo(0.1, 6);
  });
});

describe('wavelengthToRgb', () => {
  it('is null outside the visible range and coloured inside it', () => {
    expect(wavelengthToRgb(300)).toBeNull();
    expect(wavelengthToRgb(1000)).toBeNull();
    expect(wavelengthToRgb(650)).toMatch(/^rgb\(255,\d+,0\)$/);   // red
    expect(wavelengthToRgb(450)).toMatch(/^rgb\(\d+,\d+,255\)$/); // blue
  });
});

describe('planckExitance', () => {
  it('integrates to the Stefan–Boltzmann total', () => {
    const T = 288.15;
    const nu = Array.from({ length: 20000 }, (_, i) => 0.5 + i);   // 1 cm⁻¹ bins to 20000
    const e = planckExitance(nu, T);
    const total = e.reduce((a, v) => a + v, 0);
    expect(total / (5.670374419e-8 * T ** 4)).toBeCloseTo(1, 2);
  });
});
