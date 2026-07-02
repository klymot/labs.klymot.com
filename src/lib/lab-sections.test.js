/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSectionTracker } from './lab-sections.js';

// ── DOM helpers ─────────────────────────────────────────────────────────────

function addHeader(height) {
  const header = document.createElement('header');
  header.className = 'site-header';
  header.getBoundingClientRect = () => ({
    height, top: 0, bottom: height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {},
  });
  document.body.appendChild(header);
  return header;
}

// Builds a section element (optionally with a separate heading anchor) whose
// bounding-rect `top` is fixed to a given value, matching how the real pages'
// sections/headings are measured via getBoundingClientRect().top.
function addSection(id, { headingId = null, hidden = false, top = 0 } = {}) {
  const section = document.createElement('section');
  section.id = id;
  if (hidden) section.hidden = true;
  document.body.appendChild(section);

  let anchor = section;
  if (headingId) {
    anchor = document.createElement('h2');
    anchor.id = headingId;
    section.appendChild(anchor);
  }
  anchor.getBoundingClientRect = () => ({
    top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {},
  });
  return section;
}

function setScrollY(value) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
  setScrollY(0);
});

// ── getVisibleSectionId ───────────────────────────────────────────────────────

describe('getVisibleSectionId', () => {
  it('returns null when no section has crossed the trigger line', () => {
    addSection('a', { top: 500 });
    addSection('b', { top: 800 });
    const tracker = createSectionTracker([
      { id: 'a', headingId: null },
      { id: 'b', headingId: null },
    ]);
    expect(tracker.getVisibleSectionId()).toBeNull();
  });

  it('picks the section whose anchor top has crossed the trigger line (no header)', () => {
    // No .site-header present -> triggerY = 0 + 64 = 64
    addSection('a', { top: 10 }); // 10 <= 64: crossed
    addSection('b', { top: 500 }); // not crossed
    const tracker = createSectionTracker([
      { id: 'a', headingId: null },
      { id: 'b', headingId: null },
    ]);
    expect(tracker.getVisibleSectionId()).toBe('a');
  });

  it('accounts for the site header height in the trigger line', () => {
    addHeader(50); // triggerY = 50 + 64 = 114
    addSection('a', { top: 100 }); // 100 <= 114: crossed
    const tracker = createSectionTracker([{ id: 'a', headingId: null }]);
    expect(tracker.getVisibleSectionId()).toBe('a');
  });

  it('skips hidden sections even if their anchor has crossed the trigger line', () => {
    addSection('a', { top: -1000, hidden: true });
    addSection('b', { top: 500 }); // not crossed
    const tracker = createSectionTracker([
      { id: 'a', headingId: null },
      { id: 'b', headingId: null },
    ]);
    expect(tracker.getVisibleSectionId()).toBeNull();
  });

  it('when multiple sections have crossed the trigger line, the last one in list order wins', () => {
    addSection('a', { top: -500 });
    addSection('b', { top: -100 });
    addSection('c', { top: 10 });
    addSection('d', { top: 900 }); // not crossed
    const tracker = createSectionTracker([
      { id: 'a', headingId: null },
      { id: 'b', headingId: null },
      { id: 'c', headingId: null },
      { id: 'd', headingId: null },
    ]);
    expect(tracker.getVisibleSectionId()).toBe('c');
  });

  it('measures the heading anchor rather than the section element when headingId is set', () => {
    // Section element itself would report top 0 (default), but its heading is
    // pushed far below the trigger line, so it should NOT be considered crossed.
    const section = addSection('a', { headingId: 'a-heading', top: 900 });
    section.getBoundingClientRect = () => ({ top: -900, bottom: -900, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    const tracker = createSectionTracker([{ id: 'a', headingId: 'a-heading' }]);
    expect(tracker.getVisibleSectionId()).toBeNull();
  });

  it('ignores a section whose declared headingId element is missing', () => {
    addSection('a', { top: -10 }); // no heading child created for this id
    const tracker = createSectionTracker([{ id: 'a', headingId: 'nonexistent-heading' }]);
    expect(tracker.getVisibleSectionId()).toBeNull();
  });
});

// ── syncSectionState / onChange ───────────────────────────────────────────────

describe('syncSectionState / onChange', () => {
  it('fires onChange with the newly detected section id when it changes', () => {
    addSection('a', { top: -10 });
    const onChange = vi.fn();
    const tracker = createSectionTracker([{ id: 'a', headingId: null }], { onChange });
    tracker.syncSectionState();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('a');
    expect(tracker.getCurrentSectionId()).toBe('a');
  });

  it('does not fire onChange again when the detected section is unchanged', () => {
    addSection('a', { top: -10 });
    const onChange = vi.fn();
    const tracker = createSectionTracker([{ id: 'a', headingId: null }], { onChange });
    tracker.syncSectionState();
    tracker.syncSectionState();
    tracker.syncSectionState();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('fires onChange again once the detected section actually changes', () => {
    const a = addSection('a', { top: -10 });
    const onChange = vi.fn();
    const tracker = createSectionTracker([
      { id: 'a', headingId: null },
      { id: 'b', headingId: null },
    ], { onChange });
    tracker.syncSectionState();
    expect(onChange).toHaveBeenLastCalledWith('a');

    // "Scroll" further: hide a, reveal b as crossed.
    a.hidden = true;
    addSection('b', { top: -10 });
    tracker.syncSectionState();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('works with no onChange callback provided', () => {
    addSection('a', { top: -10 });
    const tracker = createSectionTracker([{ id: 'a', headingId: null }]);
    expect(() => tracker.syncSectionState()).not.toThrow();
    expect(tracker.getCurrentSectionId()).toBe('a');
  });
});

// ── seeding via setCurrentSectionId ────────────────────────────────────────────

describe('getCurrentSectionId / setCurrentSectionId', () => {
  it('starts as null before anything has run', () => {
    const tracker = createSectionTracker([]);
    expect(tracker.getCurrentSectionId()).toBeNull();
  });

  it('setCurrentSectionId seeds state without triggering onChange', () => {
    const onChange = vi.fn();
    const tracker = createSectionTracker([{ id: 'lab', headingId: null }], { onChange });
    tracker.setCurrentSectionId('lab');
    expect(onChange).not.toHaveBeenCalled();
    expect(tracker.getCurrentSectionId()).toBe('lab');
  });

  it('a later syncSectionState that detects the same seeded section still does not fire onChange', () => {
    addSection('lab', { top: -10 });
    const onChange = vi.fn();
    const tracker = createSectionTracker([{ id: 'lab', headingId: null }], { onChange });
    tracker.setCurrentSectionId('lab');
    tracker.syncSectionState();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── restoreSectionFromUrl ─────────────────────────────────────────────────────

describe('restoreSectionFromUrl', () => {
  it('does nothing when sec is falsy', () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl(null);
    tracker.restoreSectionFromUrl('');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing when the target element does not exist', async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl('missing');
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing when the target element is hidden', async () => {
    addSection('lab', { top: 200, hidden: true });
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl('lab');
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls to the element position, minus header height and 12px, after the current scroll offset', async () => {
    addHeader(50);
    addSection('lab', { top: 200 });
    setScrollY(100);
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl('lab');
    await new Promise(resolve => requestAnimationFrame(resolve));
    // top = scrollY(100) + rect.top(200) - headerOffset(50) - 12 = 238
    expect(scrollTo).toHaveBeenCalledWith({ top: 238, behavior: 'auto' });
  });

  it('clamps a negative computed top to 0', async () => {
    addSection('lab', { top: -500 });
    setScrollY(0);
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl('lab');
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('works without a .site-header present (treats header offset as 0)', async () => {
    addSection('lab', { top: 300 });
    setScrollY(0);
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const tracker = createSectionTracker([]);
    tracker.restoreSectionFromUrl('lab');
    await new Promise(resolve => requestAnimationFrame(resolve));
    // top = 0 + 300 - 0 - 12 = 288
    expect(scrollTo).toHaveBeenCalledWith({ top: 288, behavior: 'auto' });
  });
});
