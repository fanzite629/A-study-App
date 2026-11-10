'use strict';
// Pet state names and the rules that map real business conditions to a state.
// This file decides WHICH state the pet is in. It never touches images:
// the character renderer separately decides which asset to show for a state
// (falling back to idle when a state has no asset).
(function (root) {
  const STATES = Object.freeze(['idle', 'focus', 'dragging', 'thinking', 'reminder', 'timeUp', 'done', 'rest', 'blink']);

  /**
   * Resolve the visible pet state from business + interaction conditions.
   * Priority (highest first):
   *   dragging > done (transient) > timeUp > reminder > rest > focus > thinking > idle
   * Because the state is recomputed from conditions (not stored), releasing a
   * drag automatically returns to whatever state the business data implies.
   *
   * @param {object} c
   * @param {boolean} [c.dragging]      user is dragging the pet
   * @param {boolean} [c.doneFlash]     a step was just completed (short-lived)
   * @param {string|null} [c.timerPhase] 'running' | 'paused' | 'due' | null
   * @param {boolean} [c.reminderOpen]  a reminder bubble is showing
   * @param {boolean} [c.resting]       a break timer is running
   * @param {boolean} [c.cardOpen]      the task card / menu bubble is open
   */
  function resolveState(c) {
    c = c || {};
    if (c.dragging) return 'dragging';
    if (c.doneFlash) return 'done';
    if (c.timerPhase === 'due') return 'timeUp';
    if (c.reminderOpen) return 'reminder';
    if (c.resting) return 'rest';
    if (c.timerPhase === 'running') return 'focus';
    if (c.cardOpen) return 'thinking';
    return 'idle';
  }

  /**
   * Asset fallback: a state without a usable asset shows idle.
   * @param {string} state
   * @param {Record<string, unknown>} available  map of state -> loaded asset
   * @returns {string} the state whose asset should be displayed
   */
  function assetStateFor(state, available) {
    if (available && available[state]) return state;
    return 'idle';
  }

  const api = { STATES, resolveState, assetStateFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PetStates = api;
})(typeof self !== 'undefined' ? self : this);
