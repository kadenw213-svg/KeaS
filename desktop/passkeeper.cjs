// The payroll vault passphrase, kept for one run of KeaS so it's asked once, not at every open. Memory only: never
// written anywhere. Forgotten when the vault locks itself after a quiet spell (or Lock is chosen), when Payroll has
// been closed for that long, when the person signs out, when "Ask for my sign-in every time" is on, and on quit.
'use strict';

function createPassKeeper({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pass = null, timer = null;
  const stopTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
  const forget = () => { pass = null; stopTimer(); };
  return {
    remember(p) { stopTimer(); pass = p == null ? null : String(p); },
    get: () => pass,
    has: () => pass != null,
    forget,
    /** Payroll was closed: forget it after the vault's quiet-spell time, as the vault itself would have locked. */
    idle(ms) {
      stopTimer();
      if (pass == null) return;
      timer = setTimer(forget, Math.max(1000, Number(ms) || 15 * 60_000));
      timer?.unref?.();
    },
    /** Payroll is open again: the vault's own lock takes over. */
    active: stopTimer,
  };
}

module.exports = { createPassKeeper };
