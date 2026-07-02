// Shared scroll-spy / URL "sec=" restore logic used by both lab pages.
//
// Each lab page owns its own SECTION_IDS (which sections exist, in scroll
// order, and which heading element id anchors each one) and its own
// pushStateToUrl() (which encodes state — including the current section — into
// the URL in a page-specific way, e.g. query-string vs. hash params).
// createSectionTracker() wires those page-specific pieces into the
// section-detection/restore behavior shared by both pages.

export function createSectionTracker(sectionIds, { onChange } = {}) {
  let currentSectionId = null;

  function getVisibleSectionId() {
    const header = document.querySelector('.site-header');
    const triggerY = (header ? header.getBoundingClientRect().height : 0) + 64;
    let chosen = null;
    sectionIds.forEach(section => {
      const el = document.getElementById(section.id);
      if (!el || el.hidden) return;
      const anchor = section.headingId ? document.getElementById(section.headingId) : el;
      if (!anchor) return;
      const top = anchor.getBoundingClientRect().top;
      if (top <= triggerY) chosen = section.id;
    });
    return chosen;
  }

  function syncSectionState() {
    const next = getVisibleSectionId();
    if (next === currentSectionId) return;
    currentSectionId = next;
    if (onChange) onChange(currentSectionId);
  }

  function restoreSectionFromUrl(sec) {
    if (!sec) return;
    const el = document.getElementById(sec);
    if (!el || el.hidden) return;
    requestAnimationFrame(() => {
      const header = document.querySelector('.site-header');
      const headerOffset = header ? header.getBoundingClientRect().height : 0;
      const top = window.scrollY + el.getBoundingClientRect().top - headerOffset - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    });
  }

  return {
    getVisibleSectionId,
    syncSectionState,
    restoreSectionFromUrl,
    // Read the current section id (needed because each page's own
    // pushStateToUrl() includes sec=<currentSectionId> in its own URL-building
    // logic).
    getCurrentSectionId() {
      return currentSectionId;
    },
    // Seed the initial value (e.g. from a restored URL) without triggering
    // onChange — calling onChange during initial seeding would be a behavior
    // change, since it could fire a premature pushStateToUrl before the rest
    // of a page's init has run.
    setCurrentSectionId(id) {
      currentSectionId = id;
    },
  };
}
