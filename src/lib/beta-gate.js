// Soft lock shared by every lab still under beta testing.
//
// Not a real security boundary — the caller's checkCode is a client-side
// hash comparison, easily bypassed by anyone who opens devtools. The only
// goal is keeping a casual visitor who stumbles on an unlisted link from
// seeing anything beyond the access-code prompt; a determined person
// getting past it is out of scope.
//
// Dependencies (the hash comparison, the unlock side-effect) are injected
// so this wiring can be exercised in vitest without bcrypt or the network
// — see BetaGate.astro for the real wiring.

/**
 * @param {{
 *   gate: HTMLElement,       — full-screen overlay to hide on unlock
 *   form: HTMLFormElement,
 *   input: HTMLInputElement,
 *   error: HTMLElement,      — "[hidden]" message revealed on a wrong code
 *   checkCode: (code: string) => boolean,
 *   storageKey: string,      — localStorage flag remembering the unlock
 *   onUnlock: () => void,    — fires on every unlock, incl. the remembered one
 * }} deps
 */
export function initBetaGate({ gate, form, input, error, checkCode, storageKey, onUnlock }) {
  function unlock() {
    try { localStorage.setItem(storageKey, '1'); } catch (_) {}
    gate.style.display = 'none';
    onUnlock();
  }

  try {
    if (localStorage.getItem(storageKey) === '1') unlock();
  } catch (_) {}

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (checkCode(input.value)) {
      unlock();
    } else {
      error.hidden = false;
      input.value = '';
      input.focus();
    }
  });
}
