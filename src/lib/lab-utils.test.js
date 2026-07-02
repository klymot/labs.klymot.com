/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { cssVar, clamp } from './lab-utils.js';

// ── cssVar ────────────────────────────────────────────────────────────────────

describe('cssVar', () => {
  it('reads and trims a CSS custom property from the document root', () => {
    const original = window.getComputedStyle;
    window.getComputedStyle = (el) => {
      expect(el).toBe(document.documentElement);
      return { getPropertyValue: (name) => (name === '--accent' ? '  #d4a855  ' : '') };
    };
    try {
      expect(cssVar('--accent')).toBe('#d4a855');
    } finally {
      window.getComputedStyle = original;
    }
  });

  it('returns an empty string for an unknown variable', () => {
    const original = window.getComputedStyle;
    window.getComputedStyle = () => ({ getPropertyValue: () => '' });
    try {
      expect(cssVar('--nope')).toBe('');
    } finally {
      window.getComputedStyle = original;
    }
  });
});

// ── clamp ─────────────────────────────────────────────────────────────────────

describe('clamp', () => {
  it('returns the value unchanged when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to the lower bound when below range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to the upper bound when above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('returns the bound value when lo === hi', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });

  it('handles boundary values exactly', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});
