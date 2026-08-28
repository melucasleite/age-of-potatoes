'use client';

// The account panel: the sixth floating window, and the only one about the PLAYER rather
// than the farm.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE ANONYMOUS-FIRST CONTRACT, WHICH EVERY BUTTON IN HERE OBEYS. The player was signed
//  in anonymously the moment the game booted (`supabase/session.ts`), and their cloud save
//  row hangs off that `user.id`. So the PRIMARY verbs here are all UPGRADES — GitHub and
//  Google through `linkIdentity`, email through `updateUser` — which attach an identity to
//  the user the player already is, keeping the id and therefore the save. The one flow
//  that REPLACES the session (signing into a different, existing account) is deliberately
//  a second step behind a "sign in to an existing account" switch, with its consequence
//  written next to it, so nobody swaps farms by accident. Reconciliation after such a swap
//  is not this panel's job: cloud sync's standing conflict rule (higher tick wins,
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
  type OAuthProvider,
  getSession,
  linkEmailToCurrentUser,
  linkOAuthToCurrentUser,
  sendMagicLinkToExisting,
  signInToExistingWithOAuth,
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
      hint="Esc closes · the farm stays on this device either way"
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
  const [existingMode, setExistingMode] = useState(false);
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
          The game plays and saves on this device without them. Configuring Supabase turns this
          panel on.
        </div>
      </div>
    );
  }

  const guest = !status.signedIn || status.isAnonymous;

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

      {existingMode ? (
        <ExistingAccountSection
          busy={busy}
          email={email}
          onEmail={setEmail}
          onOAuth={(provider) => {
            void run(async () => signInToExistingWithOAuth(provider), 'Heading over to sign in…');
          }}
          onMagicLink={() => {
            void run(
              async () => sendMagicLinkToExisting(email.trim()),
              'Magic link sent — open it in this browser.',
            );
          }}
          onBack={() => {
            setExistingMode(false);
            setNotice(null);
          }}
        />
      ) : (
        <>
          {guest ? (
            <LinkSection
              busy={busy}
              email={email}
              onEmail={setEmail}
              onOAuth={(provider) => {
                void run(async () => linkOAuthToCurrentUser(provider), 'Heading over to link…');
              }}
              onEmailLink={() => {
                void run(
                  async () => linkEmailToCurrentUser(email.trim()),
                  'Confirmation email sent — click it to finish linking.',
                );
              }}
            />
          ) : (
            <SignedInSection
              busy={busy}
              onSignOut={() => {
                void run(async () => {
                  const result = await signOut();
                  // Straight back to being a guest: the memo was cleared by `signOut`, so
                  // this mints the fresh anonymous user rather than waiting for cloud
                  // sync's next cycle to do it invisibly.
                  await getSession();
                  return result;
                }, 'Signed out. Playing as a fresh guest on this device.');
              }}
            />
          )}

          <button
            type="button"
            className={s.accountSwitch}
            onMouseDown={keepFocus}
            onClick={() => {
              setExistingMode(true);
              setNotice(null);
            }}
          >
            sign in to an existing account instead…
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
  if (!status.signedIn) {
    return (
      <div className={s.accountStatusLine}>
        Not signed in yet — a guest session starts on its own.
      </div>
    );
  }
  if (status.isAnonymous) {
    return <div className={s.accountStatusLine}>Playing as guest on this device.</div>;
  }
  const providers = status.providers.filter((p) => p !== 'email');
  return (
    <div>
      <div className={s.accountStatusLine}>
        Signed in{status.email === null ? '.' : ` as ${status.email}`}
      </div>
      {providers.length === 0 ? null : (
        <div className={s.accountNote}>linked: {providers.join(' · ')}</div>
      )}
    </div>
  );
}

/**
 * The leaderboard name. Works for guests too — `profiles` takes any signed-in user — which
 * is on purpose: a player should not have to hand over an email to stop being "a farmer".
 */
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

/** The upgrade path: attach an identity to the guest the player already is. */
function LinkSection({
  busy,
  email,
  onEmail,
  onOAuth,
  onEmailLink,
}: {
  busy: boolean;
  email: string;
  onEmail: (value: string) => void;
  onOAuth: (provider: OAuthProvider) => void;
  onEmailLink: () => void;
}) {
  const emailReady = email.trim().includes('@');
  return (
    <div className={s.accountSection}>
      <div className={s.accountSectionHead}>Keep this farm</div>
      <div className={s.accountNote}>
        Link an account and this farm — and your name — follow you to any browser. Same farm, same
        progress, nothing starts over.
      </div>
      <div className={s.accountRow}>
        <OAuthButtons busy={busy} onOAuth={onOAuth} />
      </div>
      <div className={s.accountRow}>
        <TextField
          value={email}
          placeholder="or link by email"
          label="Email to link"
          onChange={onEmail}
          onEnter={emailReady && !busy ? onEmailLink : undefined}
        />
        <button
          type="button"
          className={s.accountButton}
          disabled={busy || !emailReady}
          onMouseDown={keepFocus}
          onClick={onEmailLink}
        >
          send link
        </button>
      </div>
    </div>
  );
}

/** A permanent account's verbs: today, just the door out. */
function SignedInSection({ busy, onSignOut }: { busy: boolean; onSignOut: () => void }) {
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
        Signing out leaves the farm here and puts you back on a fresh guest session.
      </div>
    </div>
  );
}

/**
 * The session-REPLACING flow, quarantined behind its own switch with the consequence
 * spelled out. The warning states cloud sync's actual rule rather than a vague "may lose
 * progress": whichever copy of the farm is further along wins, and the other is kept as a
 * conflict stash, never deleted (`cloudSync.ts`, `cloudHandoff.ts`).
 */
function ExistingAccountSection({
  busy,
  email,
  onEmail,
  onOAuth,
  onMagicLink,
  onBack,
}: {
  busy: boolean;
  email: string;
  onEmail: (value: string) => void;
  onOAuth: (provider: OAuthProvider) => void;
  onMagicLink: () => void;
  onBack: () => void;
}) {
  const emailReady = email.trim().includes('@');
  return (
    <div className={s.accountSection}>
      <div className={s.accountSectionHead}>Sign in to an existing account</div>
      <div className={cx(s.accountNote, s.accountNoteWarn)}>
        This signs this device into a different account. If that account's farm is further along, it
        takes over here; the current farm is kept aside, not deleted.
      </div>
      <div className={s.accountRow}>
        <OAuthButtons busy={busy} onOAuth={onOAuth} />
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

/** The two provider buttons, identical in both flows — only the verb behind them differs. */
function OAuthButtons({
  busy,
  onOAuth,
}: {
  busy: boolean;
  onOAuth: (provider: OAuthProvider) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={s.accountButton}
        disabled={busy}
        onMouseDown={keepFocus}
        onClick={() => {
          onOAuth('github');
        }}
      >
        GitHub
      </button>
      <button
        type="button"
        className={s.accountButton}
        disabled={busy}
        onMouseDown={keepFocus}
        onClick={() => {
          onOAuth('google');
        }}
      >
        Google
      </button>
    </>
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
