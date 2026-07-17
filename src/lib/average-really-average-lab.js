// Interactive driver + pure math for the "Is 'Average' Really the Average?" lab.
//
// The lab lets a reader pick a real weather station and discover, for that
// station, the gap between the daily midpoint (Tmax+Tmin)/2 and the true daily
// mean: how big it is, whether it has a shape across the year, whether it drifts
// across the years, and whether a correction fitted on part of the record holds
// up on years held back.
//
// NEUTRALITY (see LAB-DESIGN.md): the code never encodes a conclusion. Station
// order and correction-strategy order are randomised with no default; "assume
// the gap is zero" is one strategy on equal footing with the others; the holdout
// bars are computed and drawn, and the page never names a winner.
//
// gap = mid - avg, where mid = (Tmax+Tmin)/2 and avg = the true daily mean.
//
// The pure functions below are DOM-free and unit-tested in
// average-really-average-lab.test.js. The interactive driver (initAverageLab)
// follows.

/* ══════════════════════════════════════════════════════════════════════════
 * Pure math (DOM-free, tested)
 * ══════════════════════════════════════════════════════════════════════════ */

export const STRATEGIES = ['zero', 'constant', 'seasonal'];

/** Daily gap series from a station's daily_sample: gap = mid - avg, dropping
 *  days missing either value. */
export function dailyGaps(dailySample) {
  const out = [];
  for (const d of dailySample || []) {
    if (d.mid == null || d.avg == null) continue;
    out.push({ d: d.d, mid: d.mid, avg: d.avg, gap: d.mid - d.avg });
  }
  return out;
}

/** Monthly gap series from a station's monthly block. Each entry carries the
 *  ISO month key, its year and calendar month (1–12), the gap, and the day
 *  count. Months missing either mid or avg are dropped. */
export function monthlyGapSeries(monthly) {
  const out = [];
  if (!monthly || !monthly.months) return out;
  const { months, mid, avg, n } = monthly;
  for (let i = 0; i < months.length; i++) {
    if (mid[i] == null || avg[i] == null) continue;
    const key = months[i];
    out.push({
      month: key,
      year: Number(key.slice(0, 4)),
      mon: Number(key.slice(5, 7)),
      gap: mid[i] - avg[i],
      n: n ? n[i] : null,
    });
  }
  return out;
}

/** Month-of-year climatology of the gap: the average gap for each calendar
 *  month over the whole record, plus the per-year traces behind it (so a caller
 *  can show that the shape is statistical, not something to read off one year).
 *  byMonth[i] covers calendar month i+1; mean is null where that month never
 *  appears. */
export function monthOfYearClimatology(series) {
  const acc = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
  const perYear = new Map();
  for (const p of series) {
    const idx = p.mon - 1;
    acc[idx].sum += p.gap;
    acc[idx].count += 1;
    if (!perYear.has(p.year)) perYear.set(p.year, new Array(12).fill(null));
    perYear.get(p.year)[idx] = p.gap;
  }
  const byMonth = acc.map((a, i) => ({
    mon: i + 1,
    mean: a.count ? a.sum / a.count : null,
    n: a.count,
  }));
  const traces = [...perYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, values]) => ({ year, values }));
  return { byMonth, traces };
}

/** Year-by-year average gap across the record. A year needs at least minMonths
 *  monthly values to appear. */
export function annualGapSeries(series, minMonths = 1) {
  const byYear = new Map();
  for (const p of series) {
    if (!byYear.has(p.year)) byYear.set(p.year, []);
    byYear.get(p.year).push(p.gap);
  }
  return [...byYear.entries()]
    .filter(([, gaps]) => gaps.length >= minMonths)
    .sort((a, b) => a[0] - b[0])
    .map(([year, gaps]) => ({
      year,
      gap: gaps.reduce((s, x) => s + x, 0) / gaps.length,
      n: gaps.length,
    }));
}

/** Split a monthly gap series chronologically into a training block and a
 *  held-out test block. end='tail' holds back the most recent months;
 *  end='head' holds back the earliest. At least one month is always held out. */
export function splitByFraction(series, holdoutFrac, end = 'tail') {
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const total = sorted.length;
  const nTest = Math.min(total, Math.max(1, Math.round(total * holdoutFrac)));
  if (end === 'head') {
    return { test: sorted.slice(0, nTest), train: sorted.slice(nTest) };
  }
  return { train: sorted.slice(0, total - nTest), test: sorted.slice(total - nTest) };
}

/** Fit statistics from a training block: the overall mean gap and the
 *  month-of-year climatology (mean gap per calendar month, null where absent). */
export function trainStats(train) {
  const mean = train.length ? train.reduce((s, p) => s + p.gap, 0) / train.length : 0;
  const acc = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
  for (const p of train) {
    acc[p.mon - 1].sum += p.gap;
    acc[p.mon - 1].count += 1;
  }
  const climatology = acc.map((a) => (a.count ? a.sum / a.count : null));
  return { mean, climatology, n: train.length };
}

/** The correction a strategy would subtract for a given calendar month, using
 *  training statistics only. 'zero' changes nothing; 'constant' subtracts the
 *  training mean; 'seasonal' subtracts the training month-of-year value (falling
 *  back to the mean for a calendar month unseen in training). */
export function predictCorrection(strategy, stats, mon) {
  if (strategy === 'constant') return stats.mean;
  if (strategy === 'seasonal') {
    const c = stats.climatology[mon - 1];
    return c == null ? stats.mean : c;
  }
  return 0; // 'zero' and any unknown strategy
}

/** Root-mean-square of a residual array (null if empty). */
export function rmse(residuals) {
  if (!residuals.length) return null;
  const ms = residuals.reduce((s, r) => s + r * r, 0) / residuals.length;
  return Math.sqrt(ms);
}

/** Score one strategy: fit on the train block, then measure the leftover error
 *  on the test block. The residual for a test month is its actual gap minus the
 *  correction the strategy would have applied. */
export function scoreStrategy(train, test, strategy) {
  const stats = trainStats(train);
  const residuals = test.map((p) => p.gap - predictCorrection(strategy, stats, p.mon));
  return {
    strategy,
    rmse: rmse(residuals),
    mae: test.length ? residuals.reduce((s, r) => s + Math.abs(r), 0) / test.length : null,
    n: test.length,
    stats,
  };
}

/** Run the full holdout test: split the series, fit each strategy on the train
 *  block, and score all three on the held-out block. */
export function runHoldout(series, holdoutFrac, end = 'tail') {
  const { train, test } = splitByFraction(series, holdoutFrac, end);
  const results = {};
  for (const s of STRATEGIES) results[s] = scoreStrategy(train, test, s);
  return { train, test, results, stats: trainStats(train) };
}

/** One-way ANOVA from per-group summaries (n, mean, sample variance) — enough to
 *  compare how much the gap differs *between* stations against how much it wobbles
 *  *within* each, i.e. whether one station's correction could carry to another.
 *  Returns null if fewer than two groups have ≥2 observations. */
export function oneWayAnova(groups) {
  const g = (groups || []).filter((x) => x && x.n >= 2 && x.var != null);
  const k = g.length;
  const N = g.reduce((s, x) => s + x.n, 0);
  if (k < 2 || N - k < 1) return null;
  const grand = g.reduce((s, x) => s + x.n * x.mean, 0) / N;
  const ssB = g.reduce((s, x) => s + x.n * (x.mean - grand) ** 2, 0);
  const ssW = g.reduce((s, x) => s + (x.n - 1) * x.var, 0);
  const dfB = k - 1;
  const dfW = N - k;
  const msB = ssB / dfB;
  const msW = ssW / dfW;
  // sd of the station mean gaps — the scale of error from reusing one on another.
  const meanSpread = Math.sqrt(
    g.reduce((s, x) => s + (x.mean - grand) ** 2, 0) / (k - 1)
  );
  return {
    k, N, dfB, dfW,
    F: msW > 0 ? msB / msW : Infinity,
    withinSd: Math.sqrt(msW),
    meanSpread,
  };
}

// Log-gamma (Lanczos) and the regularised incomplete beta (Numerical Recipes
// betacf), enough to get an F-distribution p-value without a stats library.
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Upper-tail p-value of an F statistic (P(F ≥ f) under the null). */
export function fPValue(f, dfB, dfW) {
  if (!(f > 0) || dfB < 1 || dfW < 1) return 1;
  return betai(dfW / 2, dfB / 2, dfW / (dfW + dfB * f));
}

/* ══════════════════════════════════════════════════════════════════════════
 * Interactive driver (browser only)
 * ══════════════════════════════════════════════════════════════════════════ */

// Guarded so this module stays importable in Node for the unit tests: the
// driver only touches the DOM when initAverageLab is actually called.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STRATEGY_META = {
  zero: {
    label: 'Assume the gap is zero',
    desc: 'Change nothing — treat the midpoint as the day’s average, the way the old records do.',
  },
  constant: {
    label: 'Subtract this station’s average gap',
    desc: 'Work out one average gap from the years you keep, and take it off every month.',
  },
  seasonal: {
    label: 'Subtract a season-shaped gap',
    desc: 'Work out a separate average gap for each calendar month, and take off the one that fits.',
  },
};

const HOLDOUT_OPTIONS = [0.2, 0.3, 0.4];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtSigned(v, dp = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}`;
}

function fmtPlain(v, dp = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(dp);
}

/**
 * @param {{
 *   stations: Array<{id,name,place,climate,kind,n_months}>,
 *   introDay: object,
 *   dataBase: string,
 *   funnelPrefix: string,
 *   sendFeatureBeacon: (name:string)=>void,
 * }} config
 */
export function initAverageLab(config) {
  const {
    stations, introDay, dataBase,
    funnelPrefix, sendFeatureBeacon,
  } = config;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

  /* ── State ──────────────────────────────────────────────────────────── */
  let stationId = null;        // blocking choice
  let stationData = null;      // loaded station JSON
  let monthlySeries = null;    // monthlyGapSeries(stationData.monthly)
  let sampleMonths = [];       // distinct 'YYYY-MM' present in daily_sample
  let currentSampleMonth = null;
  let strategy = null;         // blocking choice within the game (equal footing)
  let holdoutFrac = HOLDOUT_OPTIONS[Math.floor(Math.random() * HOLDOUT_OPTIONS.length)];
  let progress = 2;            // furthest section index revealed (2 = station chooser onward)
  let holdoutRun = false;      // has the reader run the hidden-years test yet
  let hasCompleted = false;    // have they finished a full run once (enables the fast repeat path)
  // Section 1 midpoint / true-average overlays start hidden so the reader
  // reveals each candidate average themselves.
  const introShow = { mid: false, avg: false };

  let restoring = false;
  const beaconsSent = new Set();

  const els = {};
  [
    'introChart', 'introChartContainer', 'introTooltip',
    'introToggleMid', 'introToggleAvg', 'introReadout', 'introTable',
    'stationGrid', 'stationPrompt', 'stationChosen', 'stationChosenName',
    'toS3',
    'wiggleChart', 'wiggleChartContainer', 'wiggleTooltip', 'wiggleMonth',
    'wigglePrev', 'wiggleNext', 'wiggleReadout', 'toS4',
    'seasonChart', 'seasonChartContainer', 'seasonTooltip', 'seasonTraces', 'seasonBars', 'toS5',
    'yearChart', 'yearChartContainer', 'yearTooltip', 'yearReadout', 'toS6',
    'strategyGrid', 'strategyPrompt', 'holdoutRow', 'holdoutButtons',
    'runHoldout', 'runHoldoutHint',
    'holdoutChart', 'holdoutChartContainer', 'holdoutTooltip', 'holdoutReadout',
    'holdoutTable', 'holdoutChoice', 'toS7',
    'endSummary', 'resetLab', 'resetLabEnd', 'resultsBlock', 'resultsTable', 'resultsClear',
    'transferNote', 'transferExpander',
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const sections = {
    s3: document.getElementById('measure'),
    s4: document.getElementById('seasonal'),
    s5: document.getElementById('yearly'),
    s6: document.getElementById('correct'),
    s7: document.getElementById('endcard'),
  };

  const SECTION_ORDER = [
    { key: 's3', idx: 3 },
    { key: 's4', idx: 4 },
    { key: 's5', idx: 5 },
    { key: 's6', idx: 6 },
    { key: 's7', idx: 7 },
  ];

  function stationById(id) {
    return stations.find((s) => s.id === id) || null;
  }

  /* ── Canvas helpers (matches the site chart style used by the other labs) ─ */
  function setupCanvas(container, canvas) {
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    return { ctx, W, H };
  }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
    return step * mag;
  }

  // Generic framed axes; xTicks is an array of {v,label}. Returns coordinate
  // mappers. yUnit appended to y labels.
  function drawFrame(ctx, W, H, pad, xLo, xHi, yLo, yHi, xTicks, yUnit) {
    const textColor = cssVar('--text-secondary') || '#a8a090';
    const gridColor = 'rgba(212,168,85,0.12)';
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const xp = (x) => pad.left + ((x - xLo) / Math.max(1e-9, xHi - xLo)) * cW;
    const yp = (y) => pad.top + (1 - (y - yLo) / Math.max(1e-9, yHi - yLo)) * cH;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (cH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();
      const v = yHi - (yHi - yLo) * (i / 4);
      ctx.textAlign = 'right';
      ctx.fillText(`${v.toFixed(2)}${yUnit ? ' ' + yUnit : ''}`, pad.left - 6, y + 4);
    }
    ctx.textAlign = 'center';
    (xTicks || []).forEach((t) => {
      ctx.fillText(t.label, xp(t.v), H - 8);
    });
    return { xp, yp, cW, cH };
  }

  // Dashed zero line.
  function drawZero(ctx, xp, yp, xLo, xHi, cW, pad) {
    ctx.strokeStyle = 'rgba(212,168,85,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yp(0));
    ctx.lineTo(pad.left + cW, yp(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawLine(ctx, pts, xp, yp, color, width = 1.6) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => { ctx[i === 0 ? 'moveTo' : 'lineTo'](xp(p.x), yp(p.y)); });
    ctx.stroke();
  }

  function drawDots(ctx, pts, xp, yp, color, r = 2.6) {
    ctx.fillStyle = color;
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(xp(p.x), yp(p.y), r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function extentOf(values, padFrac = 0.08, minPad = 0.2) {
    let lo = Infinity; let hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * padFrac || minPad;
    return { lo: lo - pad, hi: hi + pad };
  }

  // Symmetric extent about zero (for gap charts, so neither sign is exaggerated).
  function symExtent(values, minHalf = 0.2) {
    let m = minHalf;
    for (const v of values) m = Math.max(m, Math.abs(v));
    return { lo: -m * 1.1, hi: m * 1.1 };
  }

  const GOLD = () => cssVar('--accent') || '#d4a855';
  const BLUE = () => cssVar('--series-obs') || '#5090f8';
  const MUTED = () => cssVar('--muted') || '#5a6880';

  /* ── Section 1: intro day ───────────────────────────────────────────── */
  function drawIntroChart() {
    const container = els.introChartContainer;
    const canvas = els.introChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const hours = introDay.hours;
    const temps = introDay.temps;
    const values = temps.concat([introDay.tmax, introDay.tmin]);
    if (introShow.mid) values.push(introDay.midpoint);
    if (introShow.avg) values.push(introDay.true_mean);
    const yExt = extentOf(values, 0.1, 1);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const xTicks = [0, 6, 12, 18, 23].map((h) => ({ v: h, label: `${h}h` }));
    const frame = drawFrame(ctx, W, H, pad, 0, 23, yExt.lo, yExt.hi, xTicks, '');

    // High / low marker lines.
    ctx.strokeStyle = 'rgba(212,168,85,0.25)';
    ctx.setLineDash([3, 3]);
    [introDay.tmax, introDay.tmin].forEach((v) => {
      ctx.beginPath();
      ctx.moveTo(pad.left, frame.yp(v));
      ctx.lineTo(pad.left + frame.cW, frame.yp(v));
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // The day's curve.
    const pts = hours.map((h, i) => ({ x: h, y: temps[i] }));
    drawLine(ctx, pts, frame.xp, frame.yp, cssVar('--text-secondary') || '#a8a090', 1.8);
    drawDots(ctx, pts, frame.xp, frame.yp, cssVar('--text-secondary') || '#a8a090', 2.2);

    // Candidate averages (revealed on toggle).
    const drawHLine = (v, color, label) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad.left, frame.yp(v));
      ctx.lineTo(pad.left + frame.cW, frame.yp(v));
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${label} ${v.toFixed(2)}`, pad.left + 6, frame.yp(v) - 4);
    };
    if (introShow.mid) drawHLine(introDay.midpoint, GOLD(), 'midpoint');
    if (introShow.avg) drawHLine(introDay.true_mean, BLUE(), 'all-day average');

    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Hourly temperature through ${introDay.date} at ${introDay.station}, with the day’s high and low marked.`);

    // Readout.
    if (els.introReadout) {
      const parts = [`High ${introDay.tmax.toFixed(1)}°`, `Low ${introDay.tmin.toFixed(1)}°`];
      if (introShow.mid) parts.push(`Midpoint ${introDay.midpoint.toFixed(2)}°`);
      if (introShow.avg) parts.push(`All-day average ${introDay.true_mean.toFixed(2)}°`);
      if (introShow.mid && introShow.avg) {
        parts.push(`They differ by ${fmtSigned(introDay.midpoint - introDay.true_mean)}° on this day`);
      }
      els.introReadout.textContent = parts.join('  ·  ');
    }
  }

  function fillIntroTable() {
    if (!els.introTable) return;
    const tbody = els.introTable.querySelector('tbody');
    tbody.innerHTML = introDay.hours.map((h, i) =>
      `<tr><td>${h}:00</td><td>${introDay.temps[i].toFixed(1)}</td></tr>`).join('');
  }

  /* ── Section 3: daily wiggle ────────────────────────────────────────── */
  function sampleForMonth(month) {
    return stationData.daily_sample
      .filter((d) => d.d.slice(0, 7) === month && d.mid != null && d.avg != null)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
  }

  function drawWiggleChart() {
    const container = els.wiggleChartContainer;
    const canvas = els.wiggleChart;
    if (!container || !canvas || !currentSampleMonth) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const days = sampleForMonth(currentSampleMonth);
    if (!days.length) return;
    const values = [];
    days.forEach((d) => { values.push(d.mid, d.avg); });
    const yExt = extentOf(values, 0.12, 1);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const dayNums = days.map((d) => Number(d.d.slice(8, 10)));
    const xLo = Math.min(...dayNums);
    const xHi = Math.max(...dayNums);
    const step = Math.max(1, Math.round((xHi - xLo) / 6));
    const xTicks = [];
    for (let dn = xLo; dn <= xHi; dn += step) xTicks.push({ v: dn, label: String(dn) });
    const frame = drawFrame(ctx, W, H, pad, xLo, xHi, yExt.lo, yExt.hi, xTicks, '°');

    // Gap ribbons: a faint vertical stroke from avg to mid for each day.
    ctx.strokeStyle = 'rgba(212,168,85,0.30)';
    ctx.lineWidth = 1;
    days.forEach((d, i) => {
      const x = frame.xp(dayNums[i]);
      ctx.beginPath();
      ctx.moveTo(x, frame.yp(d.avg));
      ctx.lineTo(x, frame.yp(d.mid));
      ctx.stroke();
    });

    const midPts = days.map((d, i) => ({ x: dayNums[i], y: d.mid, d }));
    const avgPts = days.map((d, i) => ({ x: dayNums[i], y: d.avg, d }));
    drawLine(ctx, avgPts, frame.xp, frame.yp, BLUE(), 1.6);
    drawDots(ctx, avgPts, frame.xp, frame.yp, BLUE(), 2.2);
    drawLine(ctx, midPts, frame.xp, frame.yp, GOLD(), 1.6);
    drawDots(ctx, midPts, frame.xp, frame.yp, GOLD(), 2.2);

    wiggleLayout = { xp: frame.xp, dayNums, days };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Daily midpoint and all-day average for ${currentSampleMonth} at ${stationData.name}.`);

    if (els.wiggleReadout) {
      const gaps = days.map((d) => d.mid - d.avg);
      const meanGap = gaps.reduce((s, x) => s + x, 0) / gaps.length;
      const minGap = Math.min(...gaps);
      const maxGap = Math.max(...gaps);
      els.wiggleReadout.textContent =
        `${days.length} days · daily gap ranges ${fmtSigned(minGap)} to ${fmtSigned(maxGap)}° ` +
        `· this month’s average gap ${fmtSigned(meanGap)}°`;
    }
  }

  let wiggleLayout = null;

  function updateWiggleMonthLabel() {
    if (!els.wiggleMonth || !currentSampleMonth) return;
    const y = currentSampleMonth.slice(0, 4);
    const m = MONTH_FULL[Number(currentSampleMonth.slice(5, 7)) - 1];
    els.wiggleMonth.textContent = `${m} ${y}`;
  }

  function setSampleMonth(month, { fromRestore = false } = {}) {
    if (!sampleMonths.includes(month)) return;
    currentSampleMonth = month;
    updateWiggleMonthLabel();
    drawWiggleChart();
    if (!fromRestore) pushState();
  }

  function stepSampleMonth(dir) {
    const i = sampleMonths.indexOf(currentSampleMonth);
    const j = Math.min(sampleMonths.length - 1, Math.max(0, i + dir));
    setSampleMonth(sampleMonths[j]);
  }

  /* ── Section 4: seasonal shape ──────────────────────────────────────── */
  let showTraces = true;
  let showBars = true;
  // "on" colour for the individual-years toggle — the secondary text tone, so the
  // active chip is clearly distinct from the greyed/half-opacity "off" state (a
  // literal light grey read almost the same as off).
  const TRACE_SWATCH = () => cssVar('--text-secondary') || '#8a8a8a';

  function drawSeasonChart() {
    const container = els.seasonChartContainer;
    const canvas = els.seasonChart;
    if (!container || !canvas || !monthlySeries) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const clim = monthOfYearClimatology(monthlySeries);
    const means = clim.byMonth.map((b) => b.mean).filter((v) => v != null);
    // Always size the y-axis to the per-year spread, whether or not the traces
    // are shown, so toggling them never rescales the axis (that motion reads as
    // distracting and makes the two views hard to compare).
    const allTraceVals = clim.traces.flatMap((t) => t.values.filter((v) => v != null));
    const yExt = symExtent(means.concat(allTraceVals), 0.3);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    // Thin the month labels on narrow screens so Jan…Dec don't overlap (bars are
    // still drawn for every month — only the axis labels drop out).
    const availW = W - pad.left - pad.right;
    const kEvery = Math.max(1, Math.ceil(12 / Math.max(3, Math.floor(availW / 34))));
    const xTicks = MONTH_LABELS
      .map((label, i) => ({ v: i + 1, label }))
      .filter((_, i) => i % kEvery === 0);
    const frame = drawFrame(ctx, W, H, pad, 0.5, 12.5, yExt.lo, yExt.hi, xTicks, '°');
    drawZero(ctx, frame.xp, frame.yp, 0.5, 12.5, frame.cW, pad);

    // Faint per-year traces behind the bold average.
    if (showTraces) {
      ctx.strokeStyle = 'rgba(160,160,160,0.18)';
      ctx.lineWidth = 1;
      clim.traces.forEach((t) => {
        ctx.beginPath();
        let started = false;
        t.values.forEach((v, i) => {
          if (v == null) { started = false; return; }
          const x = frame.xp(i + 1); const y = frame.yp(v);
          ctx[started ? 'lineTo' : 'moveTo'](x, y);
          started = true;
        });
        ctx.stroke();
      });
    }

    // Bold month-of-year average bars.
    if (showBars) {
      const barW = (frame.cW / 12) * 0.6;
      clim.byMonth.forEach((b) => {
        if (b.mean == null) return;
        const x = frame.xp(b.mon);
        const y0 = frame.yp(0);
        const y1 = frame.yp(b.mean);
        ctx.fillStyle = 'rgba(212,168,85,0.55)';
        ctx.strokeStyle = GOLD();
        ctx.lineWidth = 1;
        const top = Math.min(y0, y1);
        ctx.fillRect(x - barW / 2, top, barW, Math.abs(y1 - y0));
        ctx.strokeRect(x - barW / 2, top, barW, Math.abs(y1 - y0));
      });
    }

    seasonLayout = { xp: frame.xp, clim };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Average gap for each calendar month at ${stationData.name}, with faint per-year traces behind.`);
  }

  let seasonLayout = null;

  /* ── Section 5: year by year ────────────────────────────────────────── */
  function drawYearChart() {
    const container = els.yearChartContainer;
    const canvas = els.yearChart;
    if (!container || !canvas || !monthlySeries) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const annual = annualGapSeries(monthlySeries, 6);
    if (!annual.length) return;
    const yExt = symExtent(annual.map((a) => a.gap), 0.15);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const xLo = annual[0].year;
    const xHi = annual[annual.length - 1].year;
    const span = Math.max(1, xHi - xLo);
    // Fewer year labels on narrow screens — a 4-digit year needs ~56px, so on a
    // phone we show 2–3 rather than 6 to stop the labels overlapping.
    const availW = W - pad.left - pad.right;
    const maxTicks = Math.max(2, Math.floor(availW / 56));
    const step = niceStep(span, Math.min(6, maxTicks));
    const xTicks = [];
    for (let yr = Math.ceil(xLo / step) * step; yr <= xHi; yr += step) {
      xTicks.push({ v: yr, label: String(yr) });
    }
    const frame = drawFrame(ctx, W, H, pad, xLo - 0.5, xHi + 0.5, yExt.lo, yExt.hi, xTicks, '°');
    drawZero(ctx, frame.xp, frame.yp, xLo, xHi, frame.cW, pad);
    const pts = annual.map((a) => ({ x: a.year, y: a.gap, a }));
    drawLine(ctx, pts, frame.xp, frame.yp, GOLD(), 1.8);
    drawDots(ctx, pts, frame.xp, frame.yp, GOLD(), 2.6);
    yearLayout = { xp: frame.xp, annual };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Year-by-year average gap across the record at ${stationData.name}.`);
    if (els.yearReadout) {
      const gaps = annual.map((a) => a.gap);
      els.yearReadout.textContent =
        `${annual.length} full-ish years · yearly average gap ranges ${fmtSigned(Math.min(...gaps))} ` +
        `to ${fmtSigned(Math.max(...gaps))}°`;
    }
  }

  let yearLayout = null;

  /* ── Section 6: correction game ─────────────────────────────────────── */
  let showChoice = true;  // colour the reader's chosen strategy blue (a label, not a claim)

  function drawHoldoutChart() {
    const container = els.holdoutChartContainer;
    const canvas = els.holdoutChart;
    if (!container || !canvas || !monthlySeries || !holdoutRun) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const res = runHoldout(monthlySeries, holdoutFrac, 'tail');
    const bars = STRATEGIES.map((s) => ({ s, rmse: res.results[s].rmse }));
    const zeroRmse = res.results.zero ? res.results.zero.rmse : null;
    const maxRmse = Math.max(...bars.map((b) => b.rmse || 0), 0.01);
    const pad = { top: 18, right: 18, bottom: 52, left: 46 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const yTop = niceStep(maxRmse, 4) * Math.ceil(maxRmse / niceStep(maxRmse, 4)) || maxRmse * 1.1;
    const yp = (v) => pad.top + (1 - v / yTop) * cH;
    // y grid
    ctx.strokeStyle = 'rgba(212,168,85,0.12)';
    ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
    ctx.font = '11px system-ui, sans-serif';
    const yStep = niceStep(yTop, 4);
    for (let v = 0; v <= yTop + 1e-9; v += yStep) {
      const y = yp(v);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(2), pad.left - 6, y + 4);
    }
    const slot = cW / bars.length;
    const barW = slot * 0.5;
    const layoutBars = [];
    bars.forEach((b, i) => {
      const cx = pad.left + slot * (i + 0.5);
      const h = b.rmse == null ? 0 : (b.rmse / yTop) * cH;
      const top = pad.top + cH - h;
      const chosen = showChoice && b.s === strategy;
      ctx.fillStyle = chosen ? 'rgba(80,144,248,0.55)' : 'rgba(212,168,85,0.45)';
      ctx.strokeStyle = chosen ? BLUE() : GOLD();
      ctx.lineWidth = chosen ? 2 : 1;
      ctx.fillRect(cx - barW / 2, top, barW, h);
      ctx.strokeRect(cx - barW / 2, top, barW, h);
      // value label: the miss in °C, plus how it compares to doing nothing
      ctx.textAlign = 'center';
      if (b.rmse != null) {
        if (b.s !== 'zero' && zeroRmse) {
          const pct = Math.round((b.rmse / zeroRmse - 1) * 100);
          ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(`${pct >= 0 ? '+' : ''}${pct}% vs nothing`, cx, top - 18);
        }
        ctx.fillStyle = cssVar('--text') || '#e8e4d8';
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillText(`${b.rmse.toFixed(2)}°`, cx, top - 5);
      }
      // strategy short label (wrapped)
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
      const words = STRATEGY_SHORT[b.s].split('\n');
      words.forEach((w, li) => {
        ctx.fillText(w, cx, pad.top + cH + 16 + li * 13);
      });
      layoutBars.push({ ...b, cx, top, barW });
    });
    // Reference line at the "doing nothing" level, so every bar reads against it.
    if (zeroRmse != null) {
      const yref = yp(zeroRmse);
      ctx.save();
      ctx.strokeStyle = cssVar('--text-secondary') || '#a8a090';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, yref); ctx.lineTo(pad.left + cW, yref); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
      // Right-aligned at the far end so it never collides with the "doing nothing"
      // (zero) bar's own value label, which sits centred over the left-most bar.
      ctx.textAlign = 'right';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('doing nothing', pad.left + cW, yref - 4);
      ctx.restore();
    }
    holdoutLayout = { bars: layoutBars, res };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Leftover error on the hidden years for each strategy at ${stationData.name}.`);

    // Readout + table.
    if (els.holdoutReadout) {
      const nTest = res.test.length;
      const first = res.test[0] ? res.test[0].month : '';
      const last = res.test[res.test.length - 1] ? res.test[res.test.length - 1].month : '';
      const chosenR = strategy && res.results[strategy] ? res.results[strategy].rmse : null;
      let msg = `Each fix was built on the earlier years, then checked on ${nTest} hidden months ` +
        `(${first} to ${last}). Each bar is the typical amount it was still off by on those ` +
        `unseen months — shorter is better.`;
      if (chosenR != null && zeroRmse != null) {
        if (strategy === 'zero') {
          msg += ` You chose to change nothing: a typical miss of ±${zeroRmse.toFixed(2)}°C.`;
        } else {
          const pct = Math.round((1 - chosenR / zeroRmse) * 100);
          const cmp = pct > 0 ? `${pct}% less than doing nothing`
            : pct < 0 ? `${-pct}% more than doing nothing` : `about the same as doing nothing`;
          msg += ` Doing nothing leaves ±${zeroRmse.toFixed(2)}°C; your fix leaves ` +
            `±${chosenR.toFixed(2)}°C — ${cmp}.`;
        }
        msg += ` For scale, reading a thermometer to the nearest whole degree is already a ±0.5°C step.`;
      }
      els.holdoutReadout.textContent = msg;
    }
    fillHoldoutTable(res);
  }

  const STRATEGY_SHORT = {
    zero: 'Gap = zero',
    constant: 'Average\ngap',
    seasonal: 'Season-\nshaped',
  };

  let holdoutLayout = null;

  function fillHoldoutTable(res) {
    if (!els.holdoutTable) return;
    const tbody = els.holdoutTable.querySelector('tbody');
    tbody.innerHTML = STRATEGIES.map((s) => {
      const r = res.results[s];
      const chosen = s === strategy ? ' (your choice)' : '';
      return `<tr><td>${STRATEGY_META[s].label}${chosen}</td>` +
        `<td>${fmtPlain(r.rmse, 3)}</td><td>${fmtPlain(r.mae, 3)}</td></tr>`;
    }).join('');
  }

  /* ── Section reveal / progress ──────────────────────────────────────── */
  function revealUpTo(idx, { scroll = false, fromRestore = false } = {}) {
    progress = Math.max(progress, idx);
    SECTION_ORDER.forEach(({ key, idx: i }) => {
      const sec = sections[key];
      if (!sec) return;
      if (i <= progress) sec.hidden = false;
    });
    syncContinueButtons();
    if (scroll && !fromRestore) {
      const target = SECTION_ORDER.find((s) => s.idx === idx);
      if (target && sections[target.key]) {
        sections[target.key].scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      }
    }
    if (!fromRestore) pushState();
  }

  // A "Continue" button has done its job once the section it opens is showing;
  // hide it so it doesn't linger, and the section it opened stays open.
  function syncContinueButtons() {
    if (els.toS3) els.toS3.hidden = progress >= 4;
    if (els.toS4) els.toS4.hidden = progress >= 5;
    if (els.toS5) els.toS5.hidden = progress >= 6;
  }

  /* ── Station choice (blocking) ──────────────────────────────────────── */
  function renderStationCards() {
    const grid = els.stationGrid;
    grid.innerHTML = '';
    const tried = new Set(loadResults().map((r) => r.id));
    shuffle(stations).forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const done = tried.has(s.id);
      btn.className = 'station-card' + (s.id === stationId ? ' active' : '') + (done ? ' tried' : '');
      btn.dataset.stationId = s.id;
      btn.setAttribute('aria-pressed', s.id === stationId ? 'true' : 'false');
      const years = (s.n_months / 12);
      btn.innerHTML =
        `<span class="sc-card-text">` +
        `<span class="sc-since">${s.climate}</span>` +
        `<span class="sc-name">${s.name}</span>` +
        `<span class="sc-caveat">${s.place} · about ${years < 10 ? years.toFixed(0) : Math.round(years)} years of daily records</span>` +
        `</span>` +
        (done ? `<span class="sc-tried" aria-label="already tried">✓ tried</span>` : '');
      btn.addEventListener('click', () => chooseStation(s.id));
      grid.appendChild(btn);
    });
  }

  function updateStationCards() {
    document.querySelectorAll('#stationGrid .station-card').forEach((c) => {
      const active = c.dataset.stationId === stationId;
      c.classList.toggle('active', active);
      c.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  let loadToken = 0;
  async function chooseStation(id, { fromRestore = false } = {}) {
    const s = stationById(id);
    if (!s) return;
    stationId = id;
    updateStationCards();
    if (els.stationChosen) {
      els.stationChosen.hidden = false;
      els.stationChosenName.textContent = `${s.name}, ${s.place}`;
    }
    if (els.stationPrompt) els.stationPrompt.hidden = true;
    const token = ++loadToken;
    try {
      const resp = await fetch(`${dataBase}/${id}.json`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json();
      if (token !== loadToken) return;
      stationData = data;
      monthlySeries = monthlyGapSeries(data.monthly);
      sampleMonths = [...new Set(data.daily_sample
        .filter((d) => d.mid != null && d.avg != null)
        .map((d) => d.d.slice(0, 7)))].sort();
      if (!sampleMonths.includes(currentSampleMonth)) {
        currentSampleMonth = sampleMonths[Math.floor(Math.random() * sampleMonths.length)];
      }
      updateWiggleMonthLabel();
      // Carry the reader's correction choice across stations so repeats compare
      // like-for-like; only the run itself must be redone for the new station's data.
      holdoutRun = false;
      if (els.strategyPrompt) els.strategyPrompt.hidden = !!strategy;
      if (els.holdoutRow) els.holdoutRow.hidden = !strategy;
      renderStrategyCards();
      updateRunHoldoutState();
      if (els.toS7) els.toS7.hidden = true;
      drawAllStation();
      if (!fromRestore) {
        beacon('01-station-selected');
        if (hasCompleted && strategy) {
          // Repeat visit: everything was earned on the first run, so open it all
          // and score this station straight away — no re-clicking through, and the
          // charts and results table are there to scroll down to.
          doRunHoldout({ fromRestore: true });
          revealUpTo(7);
          if (sections.s3) sections.s3.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
        } else {
          revealUpTo(3, { scroll: true });
        }
      }
    } catch (err) {
      if (token !== loadToken) return;
      console.error('station load failed', err);
      if (els.stationPrompt) {
        els.stationPrompt.hidden = false;
        els.stationPrompt.textContent = 'Could not load that station. Try another.';
      }
    }
  }

  function drawAllStation() {
    drawWiggleChart();
    drawSeasonChart();
    drawYearChart();
    drawHoldoutChart();
    updateEndSummary();
  }

  /* ── Strategy choice (blocking, equal footing) ──────────────────────── */
  function renderStrategyCards() {
    const grid = els.strategyGrid;
    if (!grid) return;
    grid.innerHTML = '';
    shuffle(STRATEGIES).forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prediction-card' + (s === strategy ? ' chosen' : '');
      btn.dataset.strategy = s;
      btn.innerHTML =
        `<span class="prediction-card-label">${STRATEGY_META[s].label}</span>` +
        `<span class="prediction-card-desc">${STRATEGY_META[s].desc}</span>`;
      btn.addEventListener('click', () => chooseStrategy(s));
      grid.appendChild(btn);
    });
  }

  function chooseStrategy(s, { fromRestore = false } = {}) {
    if (!STRATEGIES.includes(s)) return;
    strategy = s;
    document.querySelectorAll('#strategyGrid .prediction-card').forEach((c) => {
      c.classList.toggle('chosen', c.dataset.strategy === s);
    });
    if (els.strategyPrompt) els.strategyPrompt.hidden = true;
    if (els.holdoutRow) els.holdoutRow.hidden = false;
    updateRunHoldoutState();
    if (holdoutRun) drawHoldoutChart();
    if (!fromRestore) { beacon('02-strategy-selected'); pushState(); }
  }

  function updateRunHoldoutState() {
    if (!els.runHoldout) return;
    els.runHoldout.disabled = !strategy;
    els.runHoldoutHint.textContent = strategy
      ? 'Fits all three strategies on the years you keep, then measures each one’s leftover error on the years held back.'
      : 'Pick a strategy above first.';
  }

  function setHoldout(frac, { fromRestore = false } = {}) {
    if (!HOLDOUT_OPTIONS.includes(frac)) return;
    holdoutFrac = frac;
    document.querySelectorAll('[data-holdout]').forEach((btn) => {
      const active = Number(btn.getAttribute('data-holdout')) === frac;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (holdoutRun) drawHoldoutChart();
    if (!fromRestore) pushState();
  }

  function doRunHoldout({ fromRestore = false } = {}) {
    if (!strategy || !monthlySeries) return;
    holdoutRun = true;
    hasCompleted = true;
    drawHoldoutChart();
    if (els.toS7) els.toS7.hidden = false;
    updateEndSummary();
    recordResult();
    if (!fromRestore) {
      beacon('03-holdout-run');
      revealUpTo(7);
      pushState();
    }
  }

  /* ── End card ───────────────────────────────────────────────────────── */
  function updateEndSummary() {
    if (!els.endSummary || !stationData) return;
    els.endSummary.textContent =
      `You measured the gap at ${stationData.name}, saw its shape across the year and across the record, ` +
      `and tested three ways of correcting it on years the fit never saw.`;
  }

  /* ── Results table (persists across repeats, this device only) ───────── */
  const RESULTS_KEY = 'ara-results-v1';

  function loadResults() {
    try { return JSON.parse(localStorage.getItem(RESULTS_KEY)) || []; } catch (_) { return []; }
  }
  function saveResults(arr) {
    try { localStorage.setItem(RESULTS_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  // Append (or update) this station's result, then re-render. Keyed by station so
  // re-running the same station replaces its row rather than piling up duplicates.
  function recordResult() {
    if (!stationData || !monthlySeries) return;
    const res = runHoldout(monthlySeries, holdoutFrac, 'tail');
    const key = stationData.id || stationId;
    // Per-station gap summary (all months) so the transfer test can compare
    // between-station vs within-station variation without re-loading each station.
    const gaps = monthlySeries.map((p) => p.gap);
    const nGap = gaps.length;
    const meanGap = nGap ? gaps.reduce((s, x) => s + x, 0) / nGap : 0;
    const varGap = nGap > 1
      ? gaps.reduce((s, x) => s + (x - meanGap) ** 2, 0) / (nGap - 1)
      : null;
    const row = {
      id: key,
      name: stationData.name,
      pct: Math.round(holdoutFrac * 100),
      zero: res.results.zero.rmse,
      constant: res.results.constant.rmse,
      seasonal: res.results.seasonal.rmse,
      nGap, meanGap, varGap,
    };
    const arr = loadResults().filter((r) => r.id !== key);
    arr.push(row);
    saveResults(arr);
    renderResults();
  }

  function renderResults() {
    if (!els.resultsTable) return;
    const arr = loadResults();
    // "Try another station" retires once every station has been tested.
    if (els.resetLabEnd) {
      const allTried = arr.length >= stations.length;
      els.resetLabEnd.disabled = allTried;
      els.resetLabEnd.textContent = allTried ? "You've tried every station" : 'Try another station';
    }
    if (!els.resultsBlock) return;
    if (!arr.length) { els.resultsBlock.hidden = true; return; }
    els.resultsBlock.hidden = false;
    const tb = els.resultsTable.querySelector('tbody');
    tb.innerHTML = arr.map((r) =>
      `<tr><td>${r.name}</td><td>${r.pct}%</td>` +
      `<td>${fmtPlain(r.zero, 2)}</td><td>${fmtPlain(r.constant, 2)}</td>` +
      `<td>${fmtPlain(r.seasonal, 2)}</td></tr>`).join('');
    // Highlight the reader's chosen strategy's column (zero/constant/seasonal).
    const colFor = { zero: 2, constant: 3, seasonal: 4 };
    els.resultsTable.querySelectorAll('.col-choice').forEach((c) => c.classList.remove('col-choice'));
    const ci = colFor[strategy];
    if (ci != null) {
      const th = els.resultsTable.querySelectorAll('thead th')[ci];
      if (th) th.classList.add('col-choice');
      els.resultsTable.querySelectorAll('tbody tr').forEach((tr) => {
        if (tr.children[ci]) tr.children[ci].classList.add('col-choice');
      });
    }
    renderTransfer(arr);
  }

  // Once ≥2 stations are in the table, test whether one station's fix could carry
  // to another: a one-way ANOVA of the gap, between stations vs within each.
  function renderTransfer(arr) {
    if (!els.transferNote) return;
    const groups = arr
      .filter((r) => r.varGap != null && r.nGap >= 2)
      .map((r) => ({ n: r.nGap, mean: r.meanGap, var: r.varGap }));
    const a = oneWayAnova(groups);
    if (!a) {
      els.transferNote.hidden = true;
      if (els.transferExpander) els.transferExpander.hidden = true;
      return;
    }
    els.transferNote.hidden = false;
    if (els.transferExpander) els.transferExpander.hidden = false;
    const spread = a.meanSpread.toFixed(2);
    const within = a.withinSd.toFixed(2);
    const p = fPValue(a.F, a.dfB, a.dfW);
    const pstr = p < 0.001 ? 'p < 0.001' : p < 0.01 ? 'p < 0.01'
      : p < 0.05 ? 'p < 0.05' : `p = ${p.toFixed(2)}`;
    const sig = p < 0.05;
    const cmp = a.meanSpread > a.withinSd * 1.05 ? 'between &gt; within'
      : a.withinSd > a.meanSpread * 1.05 ? 'within &gt; between'
      : 'between ≈ within';
    const desc = sig
      ? `Between stations, each station's fix (its average gap) varies by ±${spread}°C; ` +
        `within one station the gap wobbles ±${within}°C. The between-station difference is ` +
        `real, not just noise — so a fix from one station won't be exact on another (off by ` +
        `about ±${spread}°C).`
      : `Between stations the fix varies by ±${spread}°C; within one station the gap wobbles ` +
        `±${within}°C. That between-station difference is within the noise here, so one ` +
        `station's fix is a reasonable stand-in — add more stations to be surer.`;
    els.transferNote.innerHTML =
      `<span class="transfer-pill${sig ? '' : ' quiet'}">variation ${cmp} · ${pstr}</span>` +
      `<span class="transfer-desc">${desc}</span>`;
  }

  /* ── URL state ──────────────────────────────────────────────────────── */
  function pushState() {
    if (restoring) return;
    const params = new URLSearchParams();
    params.set('v', '1');
    if (stationId) params.set('s', stationId);
    if (currentSampleMonth) params.set('m', currentSampleMonth);
    if (strategy) params.set('st', strategy);
    params.set('h', String(holdoutFrac));
    if (holdoutRun) params.set('run', '1');
    params.set('p', String(progress));
    const hash = '#' + params.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readState() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    if (hash && params.get('v') !== '1') return {};
    const h = parseFloat(params.get('h') || '');
    return {
      s: params.get('s'),
      m: params.get('m'),
      st: params.get('st'),
      h: HOLDOUT_OPTIONS.includes(h) ? h : null,
      run: params.get('run') === '1',
      p: parseInt(params.get('p') || '', 10),
    };
  }

  /* ── Beacons ────────────────────────────────────────────────────────── */
  function beacon(name) {
    if (beaconsSent.has(name)) return;
    sendFeatureBeacon(`${funnelPrefix}/${name}`);
    beaconsSent.add(name);
  }

  /* ── Tooltips (nearest-x) ───────────────────────────────────────────── */
  function nearestXTooltip(canvas, tooltip, getLayout, describe) {
    if (!canvas || !tooltip) return;
    canvas.addEventListener('mousemove', (e) => {
      const layout = getLayout();
      if (!layout || !layout.points || !layout.points.length) { tooltip.hidden = true; return; }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let best = null; let bestDist = Infinity;
      layout.points.forEach((p) => {
        const dx = Math.abs(x - layout.xp(p.x));
        if (dx < bestDist) { bestDist = dx; best = p; }
      });
      if (best && bestDist < 30) {
        tooltip.textContent = describe(best);
        tooltip.hidden = false;
        const ttW = tooltip.offsetWidth || 140;
        let left = x + 14;
        if (left + ttW > rect.width - 8) left = x - ttW - 14;
        tooltip.style.left = Math.max(4, left) + 'px';
        tooltip.style.top = '12px';
      } else { tooltip.hidden = true; }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  /* ── Reset ──────────────────────────────────────────────────────────── */
  // keepChoice=true ("Try another station"): carry the correction strategy and the
  // held-back amount so repeated stations compare like-for-like. false ("Reset lab"
  // in the header): a full clean slate. Results (localStorage) persist either way.
  function reset(keepChoice = false) {
    stationId = null;
    stationData = null;
    monthlySeries = null;
    if (!keepChoice) strategy = null;
    holdoutRun = false;
    progress = 2;
    introShow.mid = false;
    introShow.avg = false;
    setIntroToggleVisual(els.introToggleMid, false, GOLD());
    setIntroToggleVisual(els.introToggleAvg, false, BLUE());
    drawIntroChart();
    SECTION_ORDER.forEach(({ key }) => { if (sections[key]) sections[key].hidden = true; });
    syncContinueButtons();  // restore the Continue buttons for the next run through
    if (els.stationChosen) els.stationChosen.hidden = true;
    if (els.stationPrompt) { els.stationPrompt.hidden = false; els.stationPrompt.textContent = 'Choose a station above to continue.'; }
    renderStationCards();
    renderStrategyCards();
    if (els.strategyPrompt) els.strategyPrompt.hidden = !!strategy;
    if (els.holdoutRow) els.holdoutRow.hidden = !strategy;
    if (!keepChoice) holdoutFrac = HOLDOUT_OPTIONS[Math.floor(Math.random() * HOLDOUT_OPTIONS.length)];
    setHoldout(holdoutFrac, { fromRestore: true });
    updateRunHoldoutState();
    pushState();
    // "Try another station" scrolls just to the chooser (not the whole way up);
    // a full "Reset lab" goes back to the top to re-read the intro.
    const stationSection = document.getElementById('station');
    if (keepChoice && stationSection) {
      stationSection.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: scrollBehavior });
    }
  }

  /* ── Wiring / init ──────────────────────────────────────────────────── */
  // Style the intro series toggles like the site's standard legend buttons:
  // a coloured border/label matching the line they reveal when on, greyed
  // (series-off) when off. Both start off, so the reader reveals each.
  function setIntroToggleVisual(btn, on, color) {
    if (!btn) return;
    btn.classList.toggle('series-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.borderColor = on ? color : '';
    btn.style.color = on ? color : '';
  }

  function wireIntroToggles() {
    if (els.introToggleMid) {
      els.introToggleMid.addEventListener('click', () => {
        introShow.mid = !introShow.mid;
        setIntroToggleVisual(els.introToggleMid, introShow.mid, GOLD());
        drawIntroChart();
      });
    }
    if (els.introToggleAvg) {
      els.introToggleAvg.addEventListener('click', () => {
        introShow.avg = !introShow.avg;
        setIntroToggleVisual(els.introToggleAvg, introShow.avg, BLUE());
        drawIntroChart();
      });
    }
  }

  function wireRedraws() {
    window.addEventListener('klymot:theme-toggled', () => {
      drawIntroChart();
      if (stationData) drawAllStation();
    });
    const ro = new ResizeObserver(() => {
      drawIntroChart();
      if (stationData) drawAllStation();
    });
    [els.introChartContainer, els.wiggleChartContainer, els.seasonChartContainer,
      els.yearChartContainer, els.holdoutChartContainer].forEach((c) => { if (c) ro.observe(c); });
  }

  function initialize() {
    fillIntroTable();
    drawIntroChart();
    renderStationCards();
    renderStrategyCards();
    wireIntroToggles();
    wireRedraws();

    if (els.wigglePrev) els.wigglePrev.addEventListener('click', () => stepSampleMonth(-1));
    if (els.wiggleNext) els.wiggleNext.addEventListener('click', () => stepSampleMonth(1));
    if (els.seasonBars) {
      setIntroToggleVisual(els.seasonBars, showBars, GOLD());
      els.seasonBars.addEventListener('click', () => {
        showBars = !showBars;
        setIntroToggleVisual(els.seasonBars, showBars, GOLD());
        drawSeasonChart();
      });
    }
    if (els.seasonTraces) {
      setIntroToggleVisual(els.seasonTraces, showTraces, TRACE_SWATCH());
      els.seasonTraces.addEventListener('click', () => {
        showTraces = !showTraces;
        setIntroToggleVisual(els.seasonTraces, showTraces, TRACE_SWATCH());
        drawSeasonChart();
      });
    }
    if (els.toS3) els.toS3.addEventListener('click', () => revealUpTo(4, { scroll: true }));
    if (els.toS4) els.toS4.addEventListener('click', () => revealUpTo(5, { scroll: true }));
    if (els.toS5) els.toS5.addEventListener('click', () => revealUpTo(6, { scroll: true }));
    document.querySelectorAll('[data-holdout]').forEach((btn) => {
      btn.addEventListener('click', () => setHoldout(Number(btn.getAttribute('data-holdout'))));
    });
    if (els.runHoldout) els.runHoldout.addEventListener('click', () => doRunHoldout());
    if (els.resetLab) els.resetLab.addEventListener('click', () => reset(false));
    if (els.resetLabEnd) els.resetLabEnd.addEventListener('click', () => reset(true));

    // "your choice" legend: colour the reader's chosen strategy blue (on by default).
    if (els.holdoutChoice) {
      setIntroToggleVisual(els.holdoutChoice, showChoice, BLUE());
      els.holdoutChoice.addEventListener('click', () => {
        showChoice = !showChoice;
        setIntroToggleVisual(els.holdoutChoice, showChoice, BLUE());
        if (holdoutRun) drawHoldoutChart();
      });
    }
    if (els.resultsClear) {
      els.resultsClear.addEventListener('click', () => { saveResults([]); renderResults(); });
    }
    renderResults();

    nearestXTooltip(els.wiggleChart, els.wiggleTooltip,
      () => (wiggleLayout ? { xp: wiggleLayout.xp, points: wiggleLayout.days.map((d, i) => ({ x: wiggleLayout.dayNums[i], d })) } : null),
      (p) => `${p.d.d}  midpoint ${p.d.mid.toFixed(2)} · all-day ${p.d.avg.toFixed(2)} · gap ${fmtSigned(p.d.mid - p.d.avg)}°`);
    nearestXTooltip(els.yearChart, els.yearTooltip,
      () => (yearLayout ? { xp: yearLayout.xp, points: yearLayout.annual.map((a) => ({ x: a.year, a })) } : null),
      (p) => `${p.a.year}  average gap ${fmtSigned(p.a.gap)}° (${p.a.n} months)`);

    // Restore from URL.
    restoring = true;
    const st = readState();
    setHoldout(st.h != null ? st.h : holdoutFrac, { fromRestore: true });
    restoring = false;

    if (st.s && stationById(st.s)) {
      chooseStation(st.s, { fromRestore: true }).then(() => {
        if (st.m && sampleMonths.includes(st.m)) setSampleMonth(st.m, { fromRestore: true });
        if (st.st) chooseStrategy(st.st, { fromRestore: true });
        if (st.run) doRunHoldout({ fromRestore: true });
        const p = Number.isFinite(st.p) ? st.p : 3;
        revealUpTo(Math.max(3, p), { fromRestore: true });
        pushState();
      });
    } else {
      pushState();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
}
