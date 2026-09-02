'use client';

// The account panel: the sixth floating window, and the only one about the PLAYER rather
// than the farm.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  ACCOUNTS ARE REQUIRED NOW ([[143]]), WHICH MADE THIS PANEL SIMPLER. The player behind
//  this window is always a real signed-in account — the sign-in door (`SignInDoor.tsx`)
//  stands in front of the whole game, so the old guest state, the anonymous "upgrade"
//  framing, and the play-without-an-account copy are all gone. So are the GitHub and
//  Google buttons (Lucas's instruction, 2026-09-02): the magic link is the only door, here
//  and on the sign-in screen. What remains is plain account management: the leaderboard
//  name, changing the account's email (`updateUser` keeps the `user.id`, and therefore the
//  saves), signing out, and — behind its own deliberate switch — signing this device into
//  a DIFFERENT account, with its consequence written next to it. Reconciliation after such
//  a swap is not this panel's job: cloud sync's standing conflict rule (higher tick wins,
//  `supabase/cloudSync.ts`) already answers it.
// ────────────────────────────────────────────────────────────────────────────────────
//
// LOADED LAZILY, AND THAT IS LOAD-BEARING. `HudRoot` mounts this through `next/dynamic`,
// so the static imports below — which reach `@supabase/supabase-js` through `client.ts` —
// live in a chunk that is fetched the first time the panel opens, never on boot. A static
// import from `HudRoot` would quietly undo `supabase/bootstrap.ts`'s whole reason to
// exist. Nothing here is awaited by anything outside the panel; every action is a button,
// and every failure is a sentence (`{ ok: false, reason }`), never a throw.
//
// ⚠️ THE KEYDOWN GUARDS ON BOTH INPUTS ARE LOAD-BEARING, exactly as `ZonePanel.tsx`'s are:
// the HUD's own panel hotkeys (T, G, I, Z, `[`) are bare `window` listeners, and without
// `stopPropagation` typing a name like "Tig" would open three panels and close this one.
// Escape in an input blurs it and stops there; Escape outside one closes the window
// through `PanelWindow`'s own listener, like every panel the input layer does not own.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type AccountStatus,
  DISPLAY_NAME_MAX,
  getAccountStatus,
  getOwnProfile,
  setDisplayName,
} from '@/supabase/profile';
import {
  type AccountActionResult,
  linkEmailToCurrentUser,
  sendMagicLink,
  signOut,
} from '@/supabase/session';

import { keepFocus, PanelWindow } from './PanelFrame';
import { cx, s } from './styles';

/** What the notice line under an action says, and in which of the HUD's two tones. */
interface Notice {
  tone: 'good' | 'warn';
  text: string;
}

export function AccountPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelWindow
      title="Account"
      tag="the name on the leaderboard"
      hint="Esc closes · every lot is backed up under this account"
      onClose={onClose}
    >
      <AccountBody />
    </PanelWindow>
  );
}

function AccountBody() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [switchMode, setSwitchMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The panel can be closed (unmounted) while a request is in flight; the flag keeps the
  // late resolution from calling setState on a corpse and printing React's warning for it.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [nextStatus, profile] = await Promise.all([getAccountStatus(), getOwnProfile()]);
    if (!alive.current) return;
    setStatus(nextStatus);
    setSavedName(profile.displayName);
  }, []);

  // One read when the panel opens. The component's whole lifetime is one visit — `HudRoot`
  // mounts it only while the window is up — so mount-time state is never stale for long,
  // and every action below re-reads through the same `refresh`.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every button funnels through here: one action in flight at a time, the failure reason
   * put where the player is looking, and the status re-read afterwards so the panel always
   * describes the world as it is now rather than as it was on open.
   */
  const run = useCallback(
    async (action: () => Promise<AccountActionResult>, doneText: string | null) => {
      setBusy(true);
      setNotice(null);
      const result = await action();
      if (!alive.current) return;
      if (result.ok) {
        if (doneText !== null) setNotice({ tone: 'good', text: doneText });
      } else {
        setNotice({ tone: 'warn', text: result.reason });
      }
      await refresh();
      if (alive.current) setBusy(false);
    },
    [refresh],
  );

  if (status === null) {
    return (
      <div className={s.accountBody}>
        <div className={s.accountNote}>checking who is playing…</div>
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className={s.accountBody}>
        <div className={s.accountStatusLine}>Cloud accounts are not set up for this build.</div>
        <div className={s.accountNote}>
          The game needs its Supabase project configured to run — see apps/web/.env.example.
        </div>
      </div>
    );
  }

  if (!status.signedIn) {
    // Transient by construction: the sign-in door gates the whole game, so a signed-out
    // status mid-panel means the session just ended and the door is about to take the
    // screen. Saying so beats rendering buttons that would all answer "Not signed in".
    return (
      <div className={s.accountBody}>
        <div className={s.accountStatusLine}>Not signed in.</div>
        <div className={s.accountNote}>
          The session has ended — the sign-in screen is about to take over.
        </div>
      </div>
    );
  }

  return (
    <div className={s.accountBody}>
      <StatusLine status={status} />

      <NameSection
        savedName={savedName}
        draft={nameDraft}
        busy={busy}
        onDraft={setNameDraft}
        onSave={() => {
          const name = (nameDraft ?? savedName ?? '').trim();
          void run(async () => setDisplayName(name), 'Saved. The leaderboard shows this name.');
          setNameDraft(null);
        }}
      />

      {switchMode ? (
        <SwitchAccountSection
          busy={busy}
          email={email}
          onEmail={setEmail}
          onMagicLink={() => {
            void run(
              async () => sendMagicLink(email.trim()),
              'Magic link sent — open it in this browser.',
            );
          }}
          onBack={() => {
            setSwitchMode(false);
            setNotice(null);
          }}
        />
      ) : (
        <>
          <EmailSection
            busy={busy}
            email={email}
            onEmail={setEmail}
            onEmailChange={() => {
              void run(
                async () => linkEmailToCurrentUser(email.trim()),
                'Confirmation email sent — click it to finish the change.',
              );
            }}
          />

          <SignOutSection
            busy={busy}
            onSignOut={() => {
              void run(
                async () => signOut(),
                // The gate in `play-client.tsx` hears the session end and puts the
                // sign-in door up; this sentence exists for the beat before it does.
                'Signed out on this device. The sign-in screen is on its way.',
              );
            }}
          />

          <button
            type="button"
            className={s.accountSwitch}
            onMouseDown={keepFocus}
            onClick={() => {
              setSwitchMode(true);
              setNotice(null);
            }}
          >
            sign in to a different account instead…
          </button>
        </>
      )}

      {notice === null ? null : (
        <div
          className={cx(
            s.accountNotice,
            notice.tone === 'good' ? s.accountNoticeGood : s.accountNoticeWarn,
          )}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}

/** One line saying who is playing, from the live status — never from a guess. */
function StatusLine({ status }: { status: AccountStatus }) {
  return (
    <div className={s.accountStatusLine}>
      Signed in{status.email === null ? '.' : ` as ${status.email}`}
    </div>
  );
}

/** The leaderboard name: one row in `profiles`, shown to everyone, written only by you. */
function NameSection({
  savedName,
  draft,
  busy,
  onDraft,
  onSave,
}: {
  savedName: string | null;
  draft: string | null;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
}) {
  const shown = draft ?? savedName ?? '';
  const savable = shown.trim().length > 0 && draft !== null && draft.trim() !== (savedName ?? '');
  return (
    <div className={s.accountSection}>
      <div className={s.accountSectionHead}>Leaderboard name</div>
      <div className={s.accountRow}>
        <TextField
          value={shown}
          placeholder="what the leaderboard calls you"
          label="Leaderboard name"
          maxLength={DISPLAY_NAME_MAX}
          onChange={onDraft}
          onEnter={savable ? onSave : undefined}
        />
        <button
          type="button"
          className={s.accountButton}
          disabled={busy || !savable}
          onMouseDown={keepFocus}
          onClick={onSave}
        >
          save
        </button>
      </div>
    </div>
  );
}

/**
 * Plain account management: move the account to a NEW email address. `updateUser` keeps the
 * `user.id`, so the saves never notice; Supabase confirms the new address by email first.
 */
function EmailSection({
  busy,
  email,
  onEmail,
  onEmailChange,
}: {
  busy: boolean;
  email: string;
  onEmail: (value: string) => void;
  onEmailChange: () => void;
}) {
  const emailReady = email.trim().includes('@');
  return (
    <div className={s.accountSection}>
      <div className={s.accountSectionHead}>Change the account email</div>
      <div className={s.accountNote}>
        Same account, same farm — the magic link just starts landing in a different inbox.
      </div>
      <div className={s.accountRow}>
        <TextField
          value={email}
          placeholder="new email address"
          label="New email address"
          onChange={onEmail}
          onEnter={emailReady && !busy ? onEmailChange : undefined}
        />
        <button
          type="button"
          className={s.accountButton}
          disabled={busy || !emailReady}
          onMouseDown={keepFocus}
          onClick={onEmailChange}
        >
          send link
        </button>
      </div>
    </div>
  );
}

/** The door out. The sign-in door is what is on the other side of it now. */
function SignOutSection({ busy, onSignOut }: { busy: boolean; onSignOut: () => void }) {
  return (
    <div className={s.accountSection}>
      <button
        type="button"
        className={s.accountButton}
        disabled={busy}
        onMouseDown={keepFocus}
        onClick={onSignOut}
      >
        sign out on this device
      </button>
      <div className={s.accountNote}>
        Signing out closes the game back to the sign-in screen. Your lots stay saved — here and in
        the cloud — and are all waiting when you sign back in.
      </div>
    </div>
  );
}

/**
 * The session-REPLACING flow, quarantined behind its own switch with the consequence
 * spelled out. The warning states cloud sync's actual rule rather than a vague "may lose
 * progress": whichever copy of a farm is further along wins, and the other is kept as a
 * conflict stash, never deleted (`cloudSync.ts`, `cloudHandoff.ts`).
 */
function SwitchAccountSection({
  busy,
  email,
  onEmail,
  onMagicLink,
  onBack,
}: {
  busy: boolean;
  email: string;
  onEmail: (value: string) => void;
  onMagicLink: () => void;
  onBack: () => void;
}) {
  const emailReady = email.trim().includes('@');
  return (
    <div className={s.accountSection}>
      <div className={s.accountSectionHead}>Sign in to a different account</div>
      <div className={cx(s.accountNote, s.accountNoteWarn)}>
        This signs this device into another account. If that account&rsquo;s farm is further along,
        it takes over here; the current farm is kept aside, not deleted.
      </div>
      <div className={s.accountRow}>
        <TextField
          value={email}
          placeholder="email for a magic link"
          label="Email for a magic link"
          onChange={onEmail}
          onEnter={emailReady && !busy ? onMagicLink : undefined}
        />
        <button
          type="button"
          className={s.accountButton}
          disabled={busy || !emailReady}
          onMouseDown={keepFocus}
          onClick={onMagicLink}
        >
          send magic link
        </button>
      </div>
      <button type="button" className={s.accountSwitch} onMouseDown={keepFocus} onClick={onBack}>
        ‹ back
      </button>
    </div>
  );
}

/**
 * A text input wearing the HUD's third and fourth keydown guards — see the header ⚠️.
 * Enter fires the row's action when the row says it is ready; Escape abandons focus and,
 * because propagation stops here, does NOT close the panel or reach the input layer's
 * cascade — the second Escape does, through `PanelWindow`'s own listener.
 */
function TextField({
  value,
  placeholder,
  label,
  maxLength,
  onChange,
  onEnter,
}: {
  value: string;
  placeholder: string;
  label: string;
  maxLength?: number;
  onChange: (value: string) => void;
  onEnter?: () => void;
}) {
  return (
    <input
      className={s.accountInput}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      maxLength={maxLength}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          onEnter?.();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.currentTarget.blur();
        }
      }}
      onKeyUp={(event) => {
        event.stopPropagation();
      }}
    />
  );
}
