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

Anchor everything in the existing Klymot teal. These hexes come from the live
logo and are the source of truth for brand colour:

| Token | Hex | Role |
|---|---|---|
| `teal-900` | `#085041` | Deepest brand / light‑mode display text |
| `teal-700` | `#0F6E56` | Light‑mode primary / links / accents |
| `teal-500` | `#1D9E75` | Mid teal / fills |
| `teal-300` | `#5DCAA5` | Dark‑mode primary / accents |
| `teal-100` | `#E1F5EE` | Light tint / dark‑mode body text |
| `neutral-500` | `#5F5E5A` | Muted captions, taglines |

Build the page from semantic tokens, themed for both modes. The brand teals
above are fixed; the **background/surface values below should be confirmed
against the main site's chrome** and adjusted to match exactly:

```css
:root {              /* light (default) */
  --bg:        #ffffff;
  --surface:   #f6f8f7;
  --text:      #11201c;
  --muted:     #5f5e5a;
  --border:    #e1e7e4;
  --accent:    #0f6e56;   /* teal-700 */
  --accent-strong: #085041;
  --link:      #0f6e56;
}
:root[data-theme="dark"] {
  --bg:        #0c1512;
  --surface:   #12211c;
  --text:      #e1f5ee;   /* teal-100 */
  --muted:     #8a938f;
  --border:    #1f2d28;
  --accent:    #5dcaa5;   /* teal-300 */
  --accent-strong: #1d9e75;
  --link:      #5dcaa5;
}
```

### 1.2 Typography

The main site uses a sans system referenced as `var(--font-sans)` — reuse it
verbatim so headings and body match. Set:

- **Body / display:** the main‑site sans (`var(--font-sans)`). Minimal & modern;
  no serif display face — that would break from the main site.
- **Mono:** one mono face for coordinates, station IDs, numeric readouts, code,
  and DOIs (`var(--font-mono)`). Numbers in tables/tooltips should be tabular.
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

### 1.3 Spacing & radii

4px base scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Section vertical rhythm is
generous (≥48px between sections) so the scroll‑to‑next feels like turning a
page. Match the main site's border radius (likely small/0 given the minimal
logo — confirm).

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

### 10.1 What the labs first‑attempt already does — and what's missing

The current labs pages (`labs.klymot.com/docs/index.html`,
`.../sunshine-temperature/index.html`) already fire tier‑1: an **inline** beacon
in `<head>` that posts `{ path: 'labs.klymot.com' + pathname, referrer }` and
skips localhost. Good — that's the right privacy posture, and the
`labs.klymot.com`‑prefixed path is a sensible convention for separating subdomain
traffic in the shared tracker. Keep that prefix.

What it's missing versus the main site:
- **It's copy‑pasted into every page's `<head>`.** Extract it into one shared
  `analytics.js` (mirroring the main site's module) and import it, so the beacon
  logic lives in exactly one place.
- **No GA tier and no consent banner.** If Labs should match the main site's
  offering, port `consent.js` + the cookie‑banner markup. If Labs is intended to
  be GA‑free (tier‑1 only), that's a legitimate choice — but **make it a decision,
  not an omission**, and then drop the GA mentions so the two sites stay coherent.
- **No feature‑event taxonomy.** See §10.2.

### 10.2 Feature events (the bit Labs should add)

The main site maps interaction events to synthetic `/__feature__/…` paths that
beacon to the self‑hosted tracker *regardless of consent* (and to GA only if
consented). Labs has its own meaningful interactions worth measuring with the
same pattern — phrased neutrally, never capturing *which* answer a reader chose
in a way that could out them, just that an interaction happened:

| Event | Synthetic path | When |
|---|---|---|
| `blocking_choice_made` | `/__feature__/labs-choice-{slug}` | A gated choice is committed (slug = the question, e.g. `model`, **not** the chosen value) |
| `section_unlocked` | `/__feature__/labs-unlock-{n}` | Section *n* reveals — a clean funnel of how far readers get |
| `chart_zoom` / `chart_pan` | `/__feature__/labs-chart-zoom` | First zoom/pan on a chart (debounced; don't beacon every frame) |
| `series_toggled` | `/__feature__/labs-series` | Legend series toggled |
| `overlay_toggled` | `/__feature__/labs-overlay-{trend\|loess}` | Trend/LOESS overlay toggled |
| `share_link_copied` | `/__feature__/labs-share` | "Copy link to this view" used |
| `shared_link_opened` | `/__feature__/labs-shared-open` | Arrived via a link carrying choices (pairs with §6.3) |
| `reset_choices` | `/__feature__/labs-reset` | "Start fresh" used |
| `source_opened` | `/__feature__/labs-source` | A Data Sources DOI/link clicked |

**Bias rule for analytics, too:** beacon the *fact* of a choice and *which
question* it answered, never the chosen value — the section‑unlock funnel and
engagement are what you want, not a distribution of answers that you (or anyone
seeing the dashboard) could read as a "result." Letting the data speak applies to
your own telemetry.

### 10.3 Integration notes

- **Reuse, don't reinvent the endpoint contract.** Same URL, same `{path,
  referrer}` shape, same `text/plain` Blob, same localhost guard — so the
  existing `api.klymot.com` `/api/v1/usage` handler needs **zero changes** to
  absorb Labs traffic (synthetic paths are just more paths).
- **One module, imported everywhere.** As Labs grows past two pages, the inline
  copy will drift. Move to `js/analytics.js` now while it's cheap.
- **Consent + theme are independent.** Consent state (`klymot-consent` in
  `localStorage`) and theme are both viewing‑side, and neither belongs in the
  shareable URL (§6).
- **GA consent visibility:** the main site beacons consent status as
  `/__consent__/{accepted|declined|pending}` so the self‑hosted dashboard shows a
  consent breakdown without backend changes. If Labs keeps GA, keep this; if Labs
  is tier‑1 only, it's moot.

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

## 13. Open items to confirm

- **Analytics scope for Labs:** match the main site's two tiers (anonymous beacon
  **+** consent‑gated GA4), or run **tier‑1 only** (beacon, no GA, no cookie
  banner)? Decide explicitly, then make the guide/code consistent (§10).
- **Extract the inline beacon** into a shared `js/analytics.js` and add the Labs
  feature‑event taxonomy (§10.2).
- **Brand consistency:** the current first‑attempt lab uses a navy `#0a1628` /
  gold `#d4a855` palette with a Playfair Display serif and a hardcoded dark theme
  — this diverges from the main site's teal/sans identity that §1 assumes. Decide
  which is canonical for Labs and align §1 (and the favicon) to it.
- **Chart approach in the first‑attempt sunshine page:** it currently loads
  `cdn.tailwindcss.com` + `chart.js@4.4.1`, which contradicts §7 (reuse the
  custom `TempChart`/`AdjChart` canvas renderers, no Chart.js on the public side).
  Reconcile before it sets a precedent. (`TempChart` in `docs/js/temp-chart.js`,
  `AdjChart` in `docs/js/adj-chart.js`). To decide: extract a shared canvas core
  vs. vendor the files into Labs, and which renderer backs each Labs chart type.
- The series‑colour palette baked into `TempChart`/`AdjChart` (so Labs charts
  match exactly — pull from the code rather than re‑inventing).
- Exact background/surface/border tokens from the main site's chrome (the brand
  teals in §1.1 are confirmed; the neutrals are proposed defaults).
- The main site's `--font-sans` / `--font-mono` stacks (reuse verbatim).
- The main site's border‑radius and the precise styling of the theme toggle.

---

*Keep this guide in the repo next to the Labs template. When the main site's
tokens or chart renderers change, this file is the single place to update so Labs
stays in lockstep.*
