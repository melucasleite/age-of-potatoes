'use client';

// The sign-in door ([[143]]): the screen before every other screen.
//
// `play-client.tsx` renders this whenever `/play` has no session — first visit, after a
// sign-out, after a session expires — and nothing else mounts until one exists.
//
// TWO WAYS THROUGH. The magic link, or "play as a guest" (Lucas, 2026-10-23: no email
// required) — an anonymous Supabase user whose saves still sync to the cloud under its own
// `user.id`. The GitHub and Google OAuth buttons stay removed (2026-09-02).
//
// THIS COMPONENT NEVER DISMISSES ITSELF. The magic link arrives by email and is clicked in
// this browser; the session materialises via the return leg (`detectSessionInUrl` in
// `supabase/client.ts` exchanges the `?code=`), the `onAuthChange` subscription in
// `play-client.tsx` hears it, and the gate swaps this screen for the lot picker. All this
// file owns is starting the flow and wording its failure.
//
// It wears `FrontDoor.module.css` on purpose — same farm backdrop, same column, same
// buttons, one screen earlier in the same flow.

import { useState } from 'react';

import { type AccountActionResult, playAsGuest, sendMagicLink } from '@/supabase/session';

import raw from './FrontDoor.module.css';

type StyleName =
  | 'door'
  | 'inner'
  | 'wordmark'
  | 'tagline'
  | 'secondary'
  | 'sectionHead'
  | 'hint'
  | 'note'
  | 'nameInput'
  | 'signinRow'
  | 'signinSend'
  | 'signinNotice'
  | 'signinNoticeGood'
  | 'signinNoticeWarn';

// The same trick `FrontDoor.tsx` documents: Next types a CSS module as an index signature
// and this workspace runs `noUncheckedIndexedAccess`, so every class would otherwise be
// `string | undefined` and a renamed class would silently paint nothing.
const s = raw as Readonly<Record<StyleName, string>>;

interface Notice {
  tone: 'good' | 'warn';
  text: string;
}

export default function SignInDoor() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  /** One action in flight at a time, its failure put where the player is looking. */
  const run = async (
    action: () => Promise<AccountActionResult>,
    doneText: string,
  ): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const result = await action();
    if (result.ok) {
      setNotice({ tone: 'good', text: doneText });
    } else {
      setNotice({ tone: 'warn', text: result.reason });
    }
    setBusy(false);
  };

  const emailReady = email.trim().includes('@');
  const magicLink = (): void => {
    if (!emailReady || busy) return;
    void run(
      async () => sendMagicLink(email.trim()),
      'Magic link sent. Open it in this browser and you will land in the game.',
    );
  };

  const guest = (): void => {
    if (busy) return;
    // No done text worth reading: the session lands at once and the gate swaps this screen out.
    void run(async () => playAsGuest(), 'Setting up your lot…');
  };

  return (
    <div className={s.door}>
      <div className={s.inner}>
        <h1 className={s.wordmark}>AGE OF POTATOES</h1>
        <p className={s.tagline}>Rent&rsquo;s paid through the month. Make chips.</p>

        <div className={s.sectionHead}>
          <span>Sign in to farm</span>
        </div>

        <p className={s.hint}>by email — no password, just a link:</p>

        <div className={s.signinRow}>
          <input
            className={s.nameInput}
            type="email"
            value={email}
            placeholder="you@somewhere.example"
            aria-label="Email for a magic link"
            spellCheck={false}
            autoComplete="email"
            // The one auto-focus on this screen, for the same reason Continue has it on the
            // next one: a returning player types their address and presses Enter without
            // reading anything.
            autoFocus
            disabled={busy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') magicLink();
            }}
          />
          <button
            type="button"
            className={s.signinSend}
            disabled={busy || !emailReady}
            onClick={magicLink}
          >
            send link
          </button>
        </div>

        <p className={s.hint}>or skip the email entirely:</p>

        <button type="button" className={s.secondary} disabled={busy} onClick={guest}>
          play as a guest
        </button>

        {notice !== null && (
          <p
            className={`${s.signinNotice} ${
              notice.tone === 'good' ? s.signinNoticeGood : s.signinNoticeWarn
            }`}
          >
            {notice.text}
          </p>
        )}

        <p className={s.note}>
          An account is how your lots follow you: every one of them is backed up to the cloud and
          waiting on any browser you sign into. First time here? Sending yourself a link creates
          your account on the way through. A guest farm lives in this browser only — add an email
          from the account panel any time to keep it.
        </p>
      </div>
    </div>
  );
}
