/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initBetaGate } from './beta-gate.js';

const STORAGE_KEY = 'test-lab-beta-unlocked';

// The repo's jsdom version doesn't provide window.localStorage, so give each
// test a minimal stand-in (and let the "unavailable" test swap in a throwing
// one). Bare `localStorage` in the lib resolves through the window global.
function installLocalStorage(overrides = {}) {
  const store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => { store.clear(); },
      ...overrides,
    },
  });
}

function buildGate() {
  document.body.innerHTML = `
    <div id="betaGate">
      <form id="betaGateForm">
        <input id="betaGateInput" type="password" />
        <button type="submit">Submit</button>
        <p id="betaGateError" hidden>Incorrect code.</p>
      </form>
    </div>
  `;
  return {
    gate: document.getElementById('betaGate'),
    form: document.getElementById('betaGateForm'),
    input: document.getElementById('betaGateInput'),
    error: document.getElementById('betaGateError'),
  };
}

function init(els, overrides = {}) {
  const onUnlock = vi.fn();
  initBetaGate({
    ...els,
    checkCode: (code) => code === 'right-code',
    storageKey: STORAGE_KEY,
    onUnlock,
    ...overrides,
  });
  return onUnlock;
}

function submit(els, code) {
  els.input.value = code;
  els.form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

beforeEach(() => {
  installLocalStorage();
  vi.restoreAllMocks();
});

describe('initBetaGate', () => {
  it('stays locked and quiet until a code is submitted', () => {
    const els = buildGate();
    const onUnlock = init(els);
    expect(els.gate.style.display).not.toBe('none');
    expect(els.error.hidden).toBe(true);
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it('rejects a wrong code: error shown, input cleared and refocused, still locked', () => {
    const els = buildGate();
    const onUnlock = init(els);
    submit(els, 'wrong-code');
    expect(els.error.hidden).toBe(false);
    expect(els.input.value).toBe('');
    expect(document.activeElement).toBe(els.input);
    expect(els.gate.style.display).not.toBe('none');
    expect(onUnlock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('unlocks on the right code: gate hidden, flag stored, onUnlock fired once', () => {
    const els = buildGate();
    const onUnlock = init(els);
    submit(els, 'right-code');
    expect(els.gate.style.display).toBe('none');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('unlocks immediately for a returning visitor with the stored flag', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const els = buildGate();
    const onUnlock = init(els);
    expect(els.gate.style.display).toBe('none');
    // A returning visitor counts as a page view straight away (see
    // BetaGate.astro) — onUnlock must fire on the remembered path too.
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('still unlocks via the form when localStorage is unavailable', () => {
    installLocalStorage({
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    const els = buildGate();
    const onUnlock = init(els);
    expect(els.gate.style.display).not.toBe('none');
    submit(els, 'right-code');
    expect(els.gate.style.display).toBe('none');
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});
