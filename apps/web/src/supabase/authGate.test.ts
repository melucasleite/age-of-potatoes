// The sign-in gate's transitions ([[143]]), pinned.
//
// Four states, two functions, and exactly one property that must never break: there is no
// path to 'signed-in' without a session, and no path anywhere out of 'unconfigured'. A
// wrong branch here is an unauthenticated player in the game — or a signed-in one locked
// out — and both render as a perfectly healthy-looking screen.

import { describe, expect, it } from 'vitest';

import { type AuthGateMode, authGateOnSession, initialAuthGate } from './authGate';

describe('initialAuthGate', () => {
  it('starts at checking when the backend is configured — the session is never knowable synchronously', () => {
    expect(initialAuthGate(true)).toBe('checking');
  });

  it('starts (and stays) at unconfigured when there is no backend', () => {
    expect(initialAuthGate(false)).toBe('unconfigured');
  });
});

describe('authGateOnSession', () => {
  it('lets a session through from checking — the ordinary signed-in reload', () => {
    expect(authGateOnSession('checking', true)).toBe('signed-in');
  });

  it('puts the door up from checking when there is no session', () => {
    expect(authGateOnSession('checking', false)).toBe('signed-out');
  });

  it('dismisses the door when the return leg lands — the OAuth/magic-link arrival', () => {
    expect(authGateOnSession('signed-out', true)).toBe('signed-in');
  });

  it('re-arms the door on sign-out', () => {
    expect(authGateOnSession('signed-in', false)).toBe('signed-out');
  });

  it('never leaves unconfigured, whatever the event claims', () => {
    expect(authGateOnSession('unconfigured', true)).toBe('unconfigured');
    expect(authGateOnSession('unconfigured', false)).toBe('unconfigured');
  });

  it('never reaches signed-in without a session, from any state', () => {
    const states: AuthGateMode[] = ['unconfigured', 'checking', 'signed-out', 'signed-in'];
    for (const state of states) {
      expect(authGateOnSession(state, false)).not.toBe('signed-in');
    }
  });
});
