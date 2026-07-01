# Klymot Labs Style Guide (Agent Version)

## Mission

* One page.
* Reader choose.
* Data show.
* Never tell reader conclusion.
* Never bias reader.
* If unsure: show, don't tell.

## Brand

* Same look as klymot.com.
* Dark default.
* Navy + gold colours.
* Same fonts.
* Same chart style.
* Same components.

## Layout

* Mobile first.
* Must work at 320px.
* Prose narrow.
* Charts wide.
* Sticky header.
* Theme toggle right.
* Back links left.

## Sections

* One long scroll.
* Choices unlock next section.
* Locked section = hidden.
* Never block scrolling.
* Data Sources always reachable.
* Smooth scroll after unlock.
* Respect reduced motion.

## Blocking choices

Blocking if choice could bias reader.

Examples:

* model
* baseline
* adjustment
* station selection

Not blocking:

* theme
* units
* decimal places
* display-only smoothing

## Bias rules

* Randomise option order.
* No default.
* No recommended option.
* Tell user options are random.
* Show chosen value afterwards.

## URL state

Store:

* version
* blocking choices
* chart state
* visible section

Do not store:

* theme
* analytics
* random order

Shared links:

* Restore analysis.
* Offer "Reset choices".

## Charts

Reuse main site canvas renderer.

Must support:

* legend toggle
* zoom
* pan
* tooltip
* reset view
* trend toggle
* LOESS toggle

No Chart.js.

Charts:

* responsive
* fixed height while loading
* accessible
* data table fallback

## Content

Write simple.
Short sentences.
Neutral voice.
No persuasion.
Explain jargon once.
Hide advanced detail behind expanders.

Good:

* "Compare the results."

Bad:

* "This proves..."

## Data sources

Every page ends with Data Sources.

Each source:

* title
* one-line description
* DOI or canonical URL
* verified

## Analytics

Reuse main site analytics.

Always:

* anonymous page beacon

Never:

* record user choices
* record which option picked

Record only:

* page visited
* funnel step completed

## Accessibility

* Keyboard works.
* 44px targets.
* WCAG AA.
* Reduced motion.
* Semantic HTML.
* One h1.

## Performance

* Static site.
* Minimal JS.
* Lazy load charts.
* No layout shift.
* Fast on mobile.

## If unsure

* Match klymot.com.
* Reader decides.
* Data speaks.
* Keep simple.
