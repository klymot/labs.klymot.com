// Pure statistics helpers for the Cherry-Picking Machine lab.
//
// Builds on the shared chart-fns implementations (OLS trend with
// AR(1)-corrected standard error, GHCNm CSV parsing, tick stepping) so the
// lab's numbers stay consistent with the main site's — the only additions
// here are windowing over an annual series and histogram accumulation.

import { trendLine, niceStep } from '../../public/js/chart-fns.js';

// Short lengths match the windows most often quoted in public arguments
// about recent trends; 30/60/90 bracket the roughly-60-year oscillation
// reported by some studies and disputed by others (see the lab page's
// "Why these window lengths?" expander) so readers can probe that
// question themselves. All six pool stations support 90-year windows in
// both dataset versions (70+ valid positions each).
export const WINDOW_LENGTHS = [15, 20, 30, 60, 90];

/**
 * Annual mean series from parsed GHCNm records, complete years only.
 * A year with any missing month is excluded entirely, so a sparse winter
 * can't seasonally skew that year's absolute mean.
 * @param {Array<{year: number, months: (number|null)[]}>} records — 0.01 °C
 * @returns {Array<{year: number, mean: number}>} — °C, ascending years
 */
export function annualMeans(records) {
  return (records ?? [])
    .filter(rec => rec.months.every(v => v != null))
    .map(rec => ({
      year: rec.year,
      mean: rec.months.reduce((s, v) => s + v, 0) / 12 / 100,
    }))
    .sort((a, b) => a.year - b.year);
}

/**
 * Minimum number of present years for an N-year window to yield a trend:
 * at least 80% of the window, and never fewer than 3 points.
 * @param {number} length
 * @returns {number}
 */
export function minYearsForWindow(length) {
  return Math.max(3, Math.ceil(0.8 * length));
}

/**
 * Fit a trend to the annual means inside [startYear, startYear+length-1].
 * Returns null when the window doesn't contain enough years.
 * @param {Array<{year: number, mean: number}>} annual
 * @param {number} startYear
 * @param {number} length
 * @returns {{startYear:number, endYear:number, nYears:number,
 *            slopePerDecade:number, ciHalfPerDecade:number}|null}
 */
export function windowTrend(annual, startYear, length) {
  const endYear = startYear + length - 1;
  const pts = annual
    .filter(d => d.year >= startYear && d.year <= endYear)
    .map(d => ({ x: d.year, y: d.mean }));
  if (pts.length < minYearsForWindow(length)) return null;
  return describeFit(trendLine(pts), pts, startYear, endYear);
}

/**
 * Shared shape for window and full-record fits. meanYear is the fit's pivot:
 * the trend line and its confidence wedge both pass through
 * (meanYear, intercept + slopePerYear·meanYear).
 */
function describeFit(fit, pts, startYear, endYear) {
  if (!fit) return null;
  const meanYear = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  return {
    startYear,
    endYear,
    nYears: pts.length,
    slopePerYear: fit.slopePerYear,
    intercept: fit.intercept,
    meanYear,
    slopePerDecade: fit.slopePerYear * 10,
    ciHalfPerDecade: 1.96 * fit.se * 10,
  };
}

/**
 * All start years whose window holds enough data for a trend.
 * @param {Array<{year: number, mean: number}>} annual
 * @param {number} length
 * @returns {number[]}
 */
export function validStartYears(annual, length) {
  if (!annual.length) return [];
  const first = annual[0].year;
  const last = annual[annual.length - 1].year;
  const present = new Set(annual.map(d => d.year));
  const required = minYearsForWindow(length);
  const starts = [];
  for (let start = first; start + length - 1 <= last; start++) {
    let n = 0;
    for (let y = start; y < start + length; y++) {
      if (present.has(y)) n++;
    }
    if (n >= required) starts.push(start);
  }
  return starts;
}

/**
 * Trend over the entire annual series (the longest window the record allows).
 * @param {Array<{year: number, mean: number}>} annual
 * @returns {{startYear:number, endYear:number, nYears:number,
 *            slopePerDecade:number, ciHalfPerDecade:number}|null}
 */
export function fullRecordTrend(annual) {
  if (annual.length < 3) return null;
  const pts = annual.map(d => ({ x: d.year, y: d.mean }));
  return describeFit(trendLine(pts), pts, annual[0].year, annual[annual.length - 1].year);
}

/**
 * Uniform-bin histogram with edges aligned to multiples of a nice bin width,
 * so bins stay stable-looking as values accumulate.
 * @param {number[]} values
 * @param {number} targetBins
 * @returns {{start:number, binWidth:number, counts:number[]}|null}
 */
export function buildHistogram(values, targetBins = 20) {
  if (!values || !values.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  let range = max - min;
  if (range <= 0) range = Math.max(Math.abs(min) * 0.2, 0.1);
  const binWidth = niceStep(range, targetBins);
  const start = Math.floor(min / binWidth) * binWidth;
  const nBins = Math.max(1, Math.floor((max - start) / binWidth) + 1);
  const counts = new Array(nBins).fill(0);
  for (const v of values) {
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((v - start) / binWidth)));
    counts[i]++;
  }
  return { start, binWidth, counts };
}

/**
 * Inclusive integer range between two values, in drag direction — used to
 * accumulate every window position a drag passed over, not just where
 * pointer events happened to land.
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
export function stepsBetween(from, to) {
  const out = [];
  const dir = to >= from ? 1 : -1;
  for (let v = from; v !== to + dir; v += dir) out.push(v);
  return out;
}
