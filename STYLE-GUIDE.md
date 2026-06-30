# labs.klymot.com — Design & Build Guide

A reference for building the Klymot Labs site: a place for hands‑on, interactive
explorations of climate (and adjacent) data. Labs sits one level below the main
explorer at `klymot.com` and shares its visual identity, but it has its own job:
walk a curious person through a piece of analysis, let them make the calls
themselves, and let the data — not the narrator — do the convincing.

The guiding rule for the whole site: **show, don't tell; and never pre‑decide
anything that a reader could be biased into.**

---

## 0. The one‑sentence brief

> A single scrolling page per topic. The reader makes the analytical choices
> themselves (in a deliberately bias‑resistant way), each choice unlocks the
> next section, charts behave exactly like the main site's, and every claim is
> backed by a verified source at the bottom. Readable on an iPhone SE, glorious
> on a desktop.

If a decision ever conflicts with that sentence, the sentence wins.

---

## 1. Visual identity (inherit from klymot.com)

Labs is a sub‑brand, not a new brand. It should feel like the same hand drew it.

### 1.1 Colour

The Klymot palette is **navy and gold** — all tokens verified against
`klymot.com/docs/css/style.css` (source of truth). Dark mode is the default;
light is opt‑in.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0a1628` | `#f4f0e8` | Page background |
| `--bg-secondary` | `#0f2047` | `#ede7d6` | Header / elevated surfaces |
| `--surface` | `#152c4a` | `#ffffff` | Cards / panels |
| `--text` | `#e8e4d8` | `#2a2218` | Primary body text |
| `--text-secondary` | `#a8a090` | `#6b5d48` | Secondary body text |
| `--muted` | `#5a6880` | `#9a8a70` | Captions, taglines |
| `--border` | `rgba(212,168,85,0.20)` | `rgba(122,95,32,0.20)` | Subtle dividers |
| `--border-strong` | `rgba(212,168,85,0.42)` | `rgba(122,95,32,0.42)` | Focused / hover borders |
| `--accent` | `#d4a855` | `#7a5f20` | Gold — links, icons, CTAs |
| `--accent-hover` | `#e0bc72` | `#5a4518` | Accent hover state |
| `--btn-bg` | `rgba(15,32,71,0.92)` | `rgba(244,240,232,0.94)` | Default button fill |
| `--btn-hover` | `rgba(21,44,74,0.97)` | `rgba(237,231,214,0.99)` | Button hover fill |

Semantic token block (dark is the `:root` default; light is `:root[data-theme="light"]`):

```css
:root {              /* dark default — matches klymot.com */
  --bg:            #0a1628;
  --bg-secondary:  #0f2047;
  --surface:       #152c4a;
  --text:          #e8e4d8;
  --text-secondary:#a8a090;
  --muted:         #5a6880;
  --border:        rgba(212, 168, 85, 0.20);
  --border-strong: rgba(212, 168, 85, 0.42);
  --accent:        #d4a855;
  --accent-hover:  #e0bc72;
  --link:          #d4a855;
  --btn-bg:        rgba(15, 32, 71, 0.92);
  --btn-hover:     rgba(21, 44, 74, 0.97);
}
:root[data-theme="light"] {
  --bg:            #f4f0e8;
  --bg-secondary:  #ede7d6;
  --surface:       #ffffff;
  --text:          #2a2218;
  --text-secondary:#6b5d48;
  --muted:         #9a8a70;
  --border:        rgba(122, 95, 32, 0.20);
  --border-strong: rgba(122, 95, 32, 0.42);
  --accent:        #7a5f20;
  --accent-hover:  #5a4518;
  --link:          #7a5f20;
  --btn-bg:        rgba(244, 240, 232, 0.94);
  --btn-hover:     rgba(237, 231, 214, 0.99);
}
```

### 1.2 Typography

Font stacks verified verbatim from `klymot.com/docs/css/style.css`:

```css
--font-sans:    'Source Sans 3', system-ui, sans-serif;
--font-mono:    'JetBrains Mono', 'Courier New', monospace;
--font-display: 'Playfair Display', Georgia, serif;
```

- **Body:** `var(--font-sans)` — Source Sans 3.
- **Headings (h1 / h2):** `var(--font-display)` — Playfair Display, matching the
  main site's header wordmark. Weight 600.
- **Mono:** `var(--font-mono)` — JetBrains Mono for coordinates, station IDs,
  numeric readouts, code, and DOIs. Numbers in tables/tooltips should be tabular
  (`font-variant-numeric: tabular-nums`).
- **Type scale (fluid, 16px root):** never set body below 16px on mobile, and
  never let any text fall below 14px. Use `clamp()` so it grows on large screens
  without a media‑query thicket:

```css
--step-0: clamp(1rem, 0.96rem + 0.2vw, 1.0625rem);     /* body  16–17 */
--step-1: clamp(1.125rem, 1.05rem + 0.4vw, 1.25rem);   /* h3 */
--step-2: clamp(1.375rem, 1.2rem + 0.8vw, 1.75rem);    /* h2 */
--step-3: clamp(1.75rem, 1.4rem + 1.6vw, 2.5rem);      /* h1 */
line-height: 1.6 for body, 1.25 for headings.
```

### 1.3 Spacing, radii & chrome

4px base scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Section vertical rhythm is
generous (≥48px between sections) so the scroll‑to‑next feels like turning a page.

**Border-radius** (verified from main site):

| Context | Value |
|---|---|
| Buttons, inputs, tags | `0.375rem` |
| Panels, cards, modals | `0.5rem` |
| Inline code / chips | `0.25rem` |

**Theme toggle** — Labs uses a single `◐` glyph (half-circle) that works for
both themes, in a 44×44 px tap target (WCAG-minimum). The main site uses two
separate `☀` / `🌙` icons toggled by `[data-theme]`. Both achieve the same
intent; keep Labs' approach for its accessibility tap-target guarantee:

```css
.theme-toggle {
  width: 44px; height: 44px;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--btn-bg);
  color: var(--text-secondary);
  font-size: 1rem;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.theme-toggle:hover  { color: var(--accent); border-color: var(--border-strong); background: var(--btn-hover); }
.theme-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

---

## 2. Responsive layout

**Mobile‑first. iPhone SE is the design target, not the fallback.**

- Design and test at **375px** (SE 2nd/3rd gen). Sanity‑check at **320px** (SE
  1st gen / narrowest realistic). Nothing should overflow or require horizontal
  scroll at 320px.
- Breakpoints: base `≤375`, `sm 480`, `md 768`, `lg 1024`, `xl 1280`.
- **Content column** caps at ~`68ch` for prose readability on big screens —
  long lines are tiring. Centre it; let margins breathe.
- **Charts break out of the prose column.** On `md+` they go effectively
  full‑width (edge‑to‑edge minus a small gutter), because a wider time axis is
  where the signal lives. On mobile they're full container width with a sensible
  min‑height. Pattern: prose in a centred narrow column, charts in a wider
  "bleed" container.
- Touch targets ≥44×44px. Controls reachable with a thumb (bottom‑weighted on
  mobile where practical).

```
┌─────────────────────────┐   mobile (≤375)        desktop (≥1024)
│  header (sticky)        │   ┌───────────────┐    ┌───────────────────────────┐
│ ← klymot  ← labs   ◐    │   │ header        │    │ header                    │
├─────────────────────────┤   ├───────────────┤    ├───────────────────────────┤
│  § intro (prose 68ch)   │   │ prose         │    │      prose (68ch, centred)│
│  ─ choice (blocking) ─  │   │ choice cards  │    │      choice cards         │
│  [ chart full‑bleed ]   │   │ chart (full w)│    │ [====== chart, wide ======]│
│  § next (gated)         │   │ gated/hidden  │    │      prose ...            │
│  …                      │   │ …             │    │                           │
│  § Data Sources         │   │ sources       │    │      Data Sources         │
└─────────────────────────┘   └───────────────┘    └───────────────────────────┘
```

---

## 3. Header

Sticky, slim, identical in spirit to the main site.

- **Left:** two back‑links — `← klymot.com` (home) and `← Labs` (the labs index).
  Use real anchor tags with clear labels, not just icons.
- **Right:** the **theme toggle**, styled exactly like the main site's. Behaviour:
  - First load follows `prefers-color-scheme` (matches the logo's media‑query
    behaviour).
  - The toggle sets an explicit override stored in `localStorage`, applied by
    setting `data-theme` on `<html>`.
  - Inline the theme‑setting script in `<head>` **before paint** to avoid a
    flash of the wrong theme (FOUC).
  - **Theme is a viewing preference, not analysis state — keep it OUT of the
    shareable URL** (see §6). A shared link should reproduce the reader's
    *choices*, not force them into the sharer's colour scheme.
- Header height counts toward `scroll-margin-top` on every section anchor so
  programmatic scrolling doesn't tuck headings under the sticky bar.

---

## 4. The scrolling, section‑gated page model

Each Labs page is **one long vertical scroll** divided into sections. A section
that contains a *blocking choice* gates the section(s) after it: the reader can't
see the next analytical step until they've committed to the choice in front of
them. This is the core anti‑bias mechanic — see §5.

### 4.1 Gating rules

- A section is **locked** until its prerequisite choice is made.
- **Locked content is hidden, not just visually blocked.** Render a compact
  locked placeholder (a line or two: "Make the choice above to continue") rather
  than the full content. Don't lay out the real content and overlay a scrim —
  that leaks the answer and bloats the DOM.
- **Scrolling is never blocked.** Critically, the **Data Sources** section at the
  bottom must always be reachable by scroll, even with everything in between
  locked. Hide the gated content's *bulk* (collapse to the small placeholder) so
  the page stays short enough to scroll past to sources. Offer a persistent
  "Jump to Data Sources ↓" affordance too.
- On unlock, **smooth‑scroll the newly revealed section into view** and respect
  `prefers-reduced-motion` (jump instantly if set). Announce the reveal to
  assistive tech (`aria-live="polite"`).

### 4.2 What is and isn't a blocking choice

- **Blocking:** any choice where knowing the "expected" answer could prime the
  reader — e.g. *which model to fit*, *which baseline period*, *raw vs adjusted*,
  *which stations*. Even if the field already has a near‑universal convention,
  make it blocking so the reader owns the decision.
- **Non‑blocking, pre‑filled OK:** choices with no plausible bias effect — units
  (°C/°F), display density, decimal places, chart smoothing window *as a display
  toggle* (as long as it doesn't change the conclusion), colour theme. Pre‑fill
  these with a sensible default and let the reader change them freely.
- When in doubt, make it blocking. The cost of an extra tap is small; the cost of
  a primed reader is the whole point of the site.

---

## 5. Bias control on choices

This is the part that makes Labs *Labs* — treat it as a methodological feature,
not UI polish.

- **Randomise the order of options for every blocking choice, per reader, per
  session.** Don't anchor anyone with a "first/default‑looking" option.
- **Label it.** Near any randomised choice, show a short, plain note:
  > *Options are shown in a random order to avoid nudging your choice.*
  Keep it calm and factual — it's a feature, and saying so builds trust.
- **No visual default / pre‑selection** on a blocking choice. No option styled as
  "recommended." No option larger, bolder, or first‑by‑convention.
- **Seed the shuffle, but encode the semantic value — not the order — in the
  URL.** A shared link records *what was chosen* (e.g. `model=ols`), so the
  recipient sees the same result; the on‑screen order can still be freshly
  randomised for them. (See §6.3 for the bias caveat on shared pre‑filled
  choices.)
- Keep the choice visible/!restate it after it's made ("You chose: OLS") so the
  reader can revisit and the conclusion stays attributable to *their* decision.

---

## 6. Shareable state in the URL ("data URLs")

> Note on naming: this means **encoding the reader's choices into the page URL**
> so a shared link reproduces the same view — not the `data:` URI scheme. Worth
> being explicit in code/comments to avoid confusion.

The site is static (GitHub Pages), so all state lives client‑side and travels in
the link.

### 6.1 Where to put it

Prefer the **hash fragment** (`#…`) over the query string:
- It never round‑trips to the server (irrelevant content for a static host, but
  also avoids any cache/SEO oddities).
- It updates without a navigation via `history.replaceState`.

```
https://labs.klymot.com/tob-recovery#v=1&model=ols&base=1961-1990&series=qcf,qcu&zoom=1900:2000
```

### 6.2 Encoding rules

- **Version it.** Lead with `v=1`. When the schema changes, bump it and keep a
  small migrator so old links don't silently break.
- **Encode semantic values, not UI state** (the chosen model, not which option
  was 2nd in the shuffled list; the visible date range, not scroll position).
- Keep it **human‑legible** while small (`model=ols`), and only reach for
  compression (e.g. base64 of a packed object) once a real link gets unwieldy.
  Legible links are easier to trust and debug.
- **Round‑trip discipline:** every blocking choice and every chart view‑state
  (zoom/pan, toggled series, trend/LOESS on/off) reads from the URL on load and
  writes back on change (debounced). Reloading a link must reproduce the exact
  view.
- Provide an explicit **"Copy link to this view"** button (don't make people fish
  the URL out of the bar on mobile). Confirm with a toast: "Link copied."

### 6.3 The bias caveat on shared links

A shared link pre‑fills a blocking choice — which is exactly the priming we work
to avoid for first‑time readers. Resolve it honestly:
- When arriving via a link that carries blocking choices, show a small banner:
  *"You're viewing a configuration someone shared. Want to start fresh and make
  the calls yourself?"* with a one‑tap **"Reset choices"**.
- This keeps sharing useful (reproducibility, "look what I found") without
  quietly turning every shared link into an anchor.

---

## 7. Charts

**Parity with the main site is the binding requirement.** Everything should look
and behave like the monthly graphs in the main site's station details.

> **The main site uses custom canvas‑based chart code, not a charting package.**
> The renderers to reuse/extend live in the main repo:
> - `docs/js/temp-chart.js` — `TempChart`, a canvas line + heatmap renderer.
> - `docs/js/adj-chart.js` — `AdjChart`, a canvas line‑plot renderer.
>
> Labs should **lift these classes (or a shared extraction of them) into the Labs
> codebase rather than introduce a charting dependency.** `package.json` has no
> chart library, and that's deliberate — keep it that way. The only third‑party
> chart code in the project is Chart.js, and it's scoped to the admin dashboard
> (`docs/admin-dashboard/index.html`) — **do not** pull Chart.js into Labs to take
> a shortcut; it would break visual parity and add a dependency the public site
> doesn't have.
>
> Practical note: factor the shared bits (axis/scale math, tooltip, legend
> hit‑testing, pan/zoom gesture handling, trend/LOESS overlay drawing) into a
> small reusable canvas core that both the main site and Labs consume, so the two
> can't drift. If that refactor is out of scope now, vendor the current files into
> Labs and track them against the originals.

### 7.1 Controls to mirror exactly

- **Legend toggles series.** Click/tap a legend entry to show/hide that series,
  same as the main site's monthly graphs. Toggled‑off state persists into the
  URL.
- **Gestures identical to main site:**
  - *Inspect:* hover (desktop) / tap (touch) for a tooltip with the values at
    that x.
  - *Zoom:* wheel/pinch and/or drag‑to‑zoom — match whichever the main site uses.
  - *Pan:* drag (and/or modifier+drag) — match the main site.
  - Always provide a **"Reset view"** control; gestures alone aren't discoverable.
- **Overlay toggles:** trend line and **LOESS** smoothing as toggleable overlays,
  styled like the main site. Default state per §4.2 (a smoothing overlay is a
  *display* aid, not a conclusion‑changer — so a pre‑filled default is fine, but
  if a smoothing choice could change the takeaway, gate it).
- Consistent colour assignment per series across all charts on a page (don't let
  "QCF" be teal in one chart and orange in the next).

### 7.2 Chart accessibility & responsiveness

- **Series palette: start from the colours already in `TempChart`/`AdjChart`** so
  Labs matches the main site exactly. Only when adding *new* series the renderers
  don't already define, extend with a colour‑vision‑deficiency‑safe set (e.g.
  Okabe–Ito), reserving brand teal for the "primary" series. Don't rely on colour
  alone — distinguish with dash patterns/markers where feasible.
- Provide a **data table fallback / "view data"** link for each chart (screen
  readers, and people who just want the numbers). Charts get `role="img"` +
  `aria-label` summarising the takeaway‑neutral facts ("monthly QCF and QCU
  series, 1895–2024").
- Charts resize to container; debounce reflow. Maintain a min‑height so a loading
  chart doesn't collapse the layout (avoid layout shift).
- Respect `prefers-reduced-motion` for any animated draw‑in.

---

## 8. Content & tone

**Accessible to all; biased toward no one.** The target: a curious 12–14‑year‑old
*and* the proverbial average grandmother should both follow the concepts. Brevity
is allowed — tuck depth into expanders.

- **Lead with the plain‑English version.** One or two short sentences that a
  newcomer gets immediately. Then offer depth.
- **Progressive disclosure.** Put the technical detail (the maths, the caveats,
  the "why this method") inside an expanding box — `<details>/<summary>` is the
  zero‑JS, accessible default:
  > ▸ *How does a 12‑month running average remove the seasonal wobble?* (tap to
  > expand)
- **Neutral framing, always.** Describe what the data shows and how it was made;
  don't tell the reader what to conclude. Avoid loaded verbs ("reveals the
  truth", "proves", "exposes"). Let the chart and the reader's own choices carry
  it. Active voice, plain verbs, sentence case (per the house writing style).
- **Define jargon on first use**, inline or via an expander. Spell out acronyms
  once (TOB = "time of observation"). A short hover/tap glossary chip is nice for
  repeat terms.
- **Empty/locked/error states give direction, not mood.** "Make the choice above
  to continue," not "Nothing here yet 🙂". Errors say what broke and what to do.
- **Engaging, not lecturing.** A light, curious voice is welcome (and fits your
  style) — analogies, a well‑placed concrete example, the occasional bit of
  delight. Just never at the expense of neutrality or clarity.

---

## 9. Data Sources (footer section)

The credibility anchor. Always reachable (§4.1).

- A clearly headed **Data Sources** section at the bottom of every Labs page.
- Each entry: human title → what it is in one line → **verified DOI link**
  (resolve to `https://doi.org/…`) and/or the canonical data URL. Show the DOI in
  mono.
- **Verify links before publish.** Keep a tiny checked‑links manifest (a CI step
  that pings each DOI/URL and fails the build on a dead link is ideal — fits your
  GitHub Actions habit). Mark each source's "last verified" date.
- List **algorithm/method references** here too (e.g. the PHA / TOB papers, the
  smoothing method), so the methodology is as traceable as the data.
- Keep it scannable: title + one line + link. Long abstracts go behind an
  expander.

---

## 10. Analytics & consent (inherit from the main site)

Labs reuses the main site's privacy‑first model, not a new one. The main site
(`www.klymot.com/docs/js/`) runs **two tiers**, and Labs should match:

1. **Always‑on, anonymous first‑party beacon** → `POST https://api.klymot.com/api/v1/usage`.
   No cookies, no consent needed. The client sends only `{ path, referrer }` as a
   `text/plain` Blob (a CORS *simple* request — no preflight) via
   `navigator.sendBeacon`, with a `fetch(..., {keepalive:true})` fallback. The
   server derives country / browser‑family / OS‑family and **discards raw IP and
   UA** — so it stays anonymous by construction. It **skips `localhost` /
   `127.0.0.1`**.
2. **Google Analytics (GA4, `G-JRMHRKGT89`), consent‑gated.** Loaded *only* after
   explicit opt‑in via the cookie banner (`consent.js`). `trackEvent` forwards to
   GA only when `window.gtag` exists (i.e. consented).

### 10.1 What labs pages emit

Every lab page fires a **page‑view beacon** on load:

```js
POST https://api.klymot.com/api/v1/usage
{ path: 'labs.klymot.com' + location.pathname, referrer: document.referrer }
```

Sent as a `text/plain` Blob via `navigator.sendBeacon` (fetch keepalive fallback).
Skips `localhost` / `127.0.0.1`. No cookies; no consent needed.

The `labs.klymot.com`‑prefixed path separates subdomain traffic in the shared
dashboard. Keep that prefix on every labs page.

The shared implementation lives in **`src/lib/analytics.js`** and exports
`sendPageBeacon()` and `sendFeatureBeacon(feature)`. Import them in a non-inline
`<script>` at the top of each page's `<head>`:

```html
<script>
  import { sendPageBeacon, sendFeatureBeacon } from '../lib/analytics.js';
  sendPageBeacon();
  // optional: expose for the page's inline app script
  window.sendFeatureBeacon = sendFeatureBeacon;
</script>
```

Astro bundles this as a deferred module; it runs after parsing, before
`window.onload` — safely before any funnel beacon calls.

### 10.2 Funnel beacons — the key scheme

Each lab also emits **funnel step beacons** via synthetic `/__feature__/…` paths.
The naming convention is:

```
/__feature__/labs/{lab-slug}/{NN}-{step-name}
```

- `{lab-slug}` — kebab-case lab identifier matching the page URL segment
  (e.g. `sunshine-temperature`).
- `{NN}` — zero-padded step index (`01`, `02`, …). Controls funnel order.
- `{step-name}` — kebab-case description of the step (e.g. `visited`,
  `station-selected`, `unlocked`).

**The admin dashboard (`www.klymot.com/docs/admin-dashboard/index.html`) parses
this pattern automatically.** Any lab that follows the convention gets its own
funnel card in the dashboard without any dashboard code changes.

#### Sunshine & Temperature — current funnel steps

| Key | When fired | Notes |
|---|---|---|
| `labs/sunshine-temperature/01-visited` | Page initialised (every load) | Fires in `initialize()` after stations load |
| `labs/sunshine-temperature/02-station-selected` | First station click | One-shot flag; does not re-fire on station change |
| `labs/sunshine-temperature/03-unlocked` | All three comparison axes chosen | Only fires if step 02 also fired this session (not URL-restore) |

#### Rules for adding a new lab

1. Choose a stable `{lab-slug}` matching the page's URL segment.
2. Identify the blocking choice points (§4.2) — each is a funnel step.
3. Define steps in order: `01-visited` is always first and fires on every page
   load; subsequent steps are one-shot (fire the first time the condition is met
   per page load).
4. Never encode *which option* was chosen — only that the step completed.
   The funnel measures progression, not answers.
5. Call `sendFeatureBeacon('labs/{slug}/{NN}-{step-name}')` at the right moment.
   Guard one-shot steps with a boolean flag initialised to `false`.

`sendFeatureBeacon` is available globally via `window.sendFeatureBeacon` once the
`<head>` module script runs (see §10.1). Lab inline scripts call it directly —
no local definition needed.

**Bias rule for analytics:** beacon the *fact* of a step completion, never the
chosen value. The dashboard shows how far readers get, not what they decided.

### 10.3 Integration notes

- **Zero API changes needed.** The `api.klymot.com` `/api/v1/usage` handler
  treats `/__feature__/labs/…` paths the same as any other feature beacon —
  they accumulate in `by_feature` and the dashboard slices them by prefix.
- **Consent + theme are independent.** Neither belongs in the shareable URL (§6).
- **GA / consent banner:** Labs currently runs tier‑1 only (no GA, no cookie
  banner). This is a deliberate choice, not an omission — keep it that way unless
  explicitly decided otherwise.

---

## 11. Accessibility & performance floor (non‑negotiable)

- Responsive to 320px; no horizontal scroll; ≥44px touch targets.
- Visible keyboard focus on every interactive element; full keyboard operability
  (choices, toggles, chart reset, expanders).
- `prefers-reduced-motion` respected for scroll and chart animation.
- Colour contrast ≥ WCAG AA in both themes (check teal‑on‑bg for links).
- Semantic landmarks (`header`, `main`, `section`, `footer`), one `h1` per page,
  logical heading order; `aria-live` for unlocks.
- Static‑host friendly: minimal JS, defer non‑critical, lazy‑load charts below
  the fold, inline the theme script to kill FOUC. Keep the page fast on a phone
  on cellular.
- **Progressive enhancement:** the prose, the Data Sources, and ideally a static
  fallback image/table for each chart should be present without JS. The
  interactivity layers on top.

---

## 12. Suggestions beyond the brief

Things worth considering, in rough priority order:

1. **Reproducibility line per chart.** A small "Reproduce this" disclosure with
   the exact parameters and the data source — turns a pretty chart into something
   someone can actually re‑derive. Pairs naturally with the shareable URL.
2. **Dead‑link CI.** As in §9 — a scheduled GitHub Action that verifies every DOI
   and data URL and opens an issue / fails the build on rot. Sources decaying
   silently would quietly erode the site's whole credibility premise.
3. **A page template / scaffold.** Since every Labs page is the same shape
   (header → gated sections → charts → sources), build one component/template so
   new explorations are mostly content + config, not bespoke layout. Keeps the
   family resemblance automatic.
4. **"What did each choice change?" recap.** A compact, neutral summary near the
   end listing the reader's choices and what each did to the result — reinforces
   that *they* drove the conclusion. State facts, not verdicts.
5. **Units & locale toggle** (°C/°F, date format) as non‑blocking prefs in the
   URL — small, friendly, removes a barrier for international/US readers.
6. **Print / export.** A clean print stylesheet (expand everything, show chart
   fallbacks and the full source list) so a teacher can hand it out. Optional
   "download this chart as PNG/CSV."
7. **Per‑section anchor links.** Tiny ¶/# on hover for each heading so people can
   link to a specific step — complements the state‑in‑URL sharing.
8. **Lightweight, privacy‑respecting analytics only** (or none). A site about not
   biasing people shouldn't feel surveilled; if you measure anything, keep it
   anonymous and say so.
9. **A neutral "Labs" wordmark lockup.** Reuse the existing logo with a small
   `· labs` or `/ labs` suffix in the same type/teal, rather than a new mark —
   keeps it unmistakably Klymot.
10. **Reduced‑data / slow‑connection mode** is overkill now, but designing charts
    to accept a pre‑aggregated payload (rather than raw per‑day arrays) will keep
    mobile snappy as datasets grow.

---

---

*Keep this guide in the repo next to the Labs template. When the main site's
tokens or chart renderers change, this file is the single place to update so Labs
stays in lockstep.*
