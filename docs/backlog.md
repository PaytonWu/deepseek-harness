# Backlog

Product-direction items that are real but not yet scheduled. Each entry states
the gap, the user-visible consequence, and the shape of the fix. An item moves
out of this file when it gets an OKR; delete an entry only when the gap no
longer exists. This file is not a design document: keep each entry short and
link owning packages or specs where they exist.

## Digital administrator: DingTalk channel onboarding

Deploying the digital administrator ([`@deepseek-ai/dsh-pi-agent`](../packages/experimental/pi-agent/README.md))
to a clean machine requires manual, developer-path setup that fails silently:

- **dws CLI presence and login are unchecked.** The transport shells out to
  the logged-in `dws` CLI; without it, admin messages fail after retries with
  no actionable report. Needed: a preflight check at admin creation that
  reports "install the DingTalk CLI and log in" with the exact commands.
- **The notification group id is hand-copied.** Users must query
  `openConversationId` via CLI and paste it into plugin config. Needed: a
  group picker backed by `dws chat list`, writing the result into pi-agent's
  persisted config.
- **The sender whitelist requires knowing your own openDingTalkId.** Needed:
  capture it automatically — for example, have the user reply to one probe
  message and admit the observed sender id.
- **Configuration lives in cordis.yml or a `--patch` overlay.** That is a
  developer path; the wizard should persist channel settings instead.

Until this lands, administrator creation on a fresh machine produces a
silently broken channel. The wizard should treat a missing or unauthenticated
`dws` as a loud precondition, not a runtime surprise.
