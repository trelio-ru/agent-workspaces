# Browser surfaces and sign-in

Choose the browser surface that is both available to the current client and
able to hold the user's own ConsultantPlus session. Browser preference is
personal to the current Trelio member and device; never configure it as a
company-wide credential or policy.

## Codex desktop

Offer the available choices only when no preference exists:

- `codex-browser` — the Codex in-app Browser. It has a separate browser profile.
  Navigate directly to `https://cloud.consultant.ru/`, then let the user sign in
  inside that browser. Use it when the user prefers a dedicated agent session.
- `codex-chrome` — the user's Chrome through the supported Chrome control
  integration. It uses the existing Chrome profile and is usually more
  convenient when the user is already signed in there.

Do not move cookies or session storage between these profiles. Do not use
Computer Use merely to evade a missing browser integration. If the user changes
their choice, verify the new visible authenticated session and run
`set-connected --browser ...` again.

## Claude Code on a local computer

Use the official Claude in Chrome integration with Chrome or Edge. The user can
start Claude Code with `claude --chrome` or connect from the session with
`/chrome`. Save the matching preference as `claude-chrome` or `claude-edge`
only after the authenticated ConsultantPlus page is visible.

Claude may navigate and interact after connection, but the user personally
completes login, CAPTCHA, passkeys, one-time codes and any other protected
account step. Never ask the user to paste those values into chat or the
terminal.

## Cloud-only agent surfaces

Codex Cloud, Claude Code on the web, remote containers and other cloud-only
surfaces ordinarily cannot access a local authenticated browser profile. Mark
the current attempt as `unavailable_on_surface` in the explanation only; do not
write it into the durable runtime state and do not convert an existing
`connected` choice to `no_access`.

When the requested result can be produced from independent official sources,
continue with that fallback. When proprietary ConsultantPlus content or its
exact export is essential, hand the task to a local Codex desktop or local
Claude Code session and explain what must be resumed there.

## Session verification

Treat a visible authenticated search or document page as the only proof that
the saved preference currently works. A browser process, tab title, cached URL
or old state file is not proof of access.

If navigation shows a sign-in or subscription-access page:

1. Run `set-needs-reconnect` and retain the saved browser preference.
2. Let the user restore access in the provider page.
3. Verify a live search or document page.
4. Run `set-connected --browser SURFACE`.

Never keep retrying protected sign-in controls, solve CAPTCHA, inspect browser
storage, open developer tools to extract session data or automate acceptance of
new legal/subscription terms.
