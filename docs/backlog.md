# Backlog

Product-direction items that are real but not yet scheduled. Each entry states the gap, the user-visible consequence, and the shape of the fix. An item moves out of this file when it gets an OKR; delete an entry only when the gap no longer exists. This file is not a design document: keep each entry short and link owning packages or specs where they exist.

## ~~Digital administrator: DingTalk channel onboarding~~ ✅ 已完成（2026-11-17，Stage 9 / M11–M14）

~~Deploying the digital administrator ([`@deepseek-ai/dsh-pi-agent`](../packages/experimental/pi-agent/README.md)) to a clean machine requires manual, developer-path setup that fails silently:~~

- ~~**dws CLI presence and login are unchecked.**~~ The wizard preflights the CLI when the admin card is picked and blocks creation until the probe passes.
- ~~**The notification group id is hand-copied.**~~ The channel setup dialog lists groups from `dws chat +chat-list` and persists the pick.
- ~~**The sender whitelist requires knowing your own openDingTalkId.**~~ A capture round admits the user's sender id automatically from one probe reply.
- ~~**Configuration lives in cordis.yml or a `--patch` overlay.**~~ Configuration persists to `~/.dsh/pi-agent/channel.json` and takes effect without a Host restart.

Landed in commit `114347bb` (spec §6, plan Stage 9).
