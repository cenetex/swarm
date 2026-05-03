# Release Notes — April 11–25, 2026

## 🆕 Telegram Bot Owner Experience (overhauled)
Onboarding a Telegram bot used to require copying webhook URLs by hand and editing JSON. Now it's a guided flow:
- **One-tap owner binding** via deep link (#1475) — paste a `t.me/...` URL, hit confirm in the bot, you're bound.
- **Group enablement via inline keyboards** (#1476) — when you add the bot to a group, owner taps "Enable" right in chat. No admin-UI round-trip.
- **DM approval keyboards** (#1477) — when a user DMs your bot, you approve/deny inline.
- **Read-only Telegram dashboard with revoke** (#1478, #1451) — see every group your bot is in, who's bound, revoke with one click.
- **Live group detection** (#1451) — add the bot to a group, the admin panel sees it within seconds.
- **Single "Save & Enable" button** (#1496), 4096-char message chunking (#1468), webhook auto-deregister on delete (#1467), and the `t.me` URL paste box that "just works" (#1447, #1449).

## ✍️ Editable Personas + Operator Prompt Override
- **Persona editing with preview-before-commit** (#1524) — edit, preview the rendered system prompt against real context, commit when it looks right.
- **Operator system prompt override** (#1526) — pin an avatar's prompt to inline text or a URL. Useful for live-iterating on prompts without redeploys.
- **Editable PromptPreviewPanel** (#1532, #1537) — configure the override directly from the admin UI, with full localization.

## 🗣 Better Voice (F5-TTS)
- **F5-TTS voice cloning** (#1530) replaces the previous XTTS pipeline. Cleaner output, faster generation.
- **Station hail messages now speak** (#1402) — autonomous station agents broadcast voice notes alongside text.

## 🎬 Media Pipeline Cleanup
- **Async video generation through the media queue** (#1494) — no more sync timeouts on `generate_video`. Real errors now surface back to the LLM instead of vanishing (#1492).
- **Videos render as videos, not broken images** (#1490).
- **Media deliveries appear in channel history** (#1495) so the bot remembers what it sent you.

## 💬 Smarter Group Behavior
- **Bots in group chats now require addressing** (#1506) — no more ambient blurts. Mention or reply to engage.
- **Quota only debits when the bot actually replies** (#1510) — failed/retried attempts no longer eat your message budget.
- **Direct-engagement spam guard** (#1535) — caps follow-up responses, enforces ambient cooldowns, scopes "bot was talking to me" detection to recent messages.
- **Shared-room mention routing** (#1562) — in chats with multiple bots, an `@MyBot` mention now reaches the right bot, not whichever bot's webhook arrived first.

## 🪪 NFT Ownership Plumbing
- **NFT ownership re-verified on access paths** (#1397) — bots tied to NFTs you no longer hold can't keep posting.
- **Webhook-side ownership gate** (#1426, #1437) — enforcement enabled at the entry point, not just creation.
- **NFT-as-avatar env wired with default whitelist** (#1568) — claim flow ready out of the box for the configured collection.

## 🔑 API Key Management UI
- **Per-avatar API key management for owners** (#1432, #1440) — generate, copy, list, delete keys. Each avatar can default chat completions to its own key (#1430).

## 🤖 Telegram Panel quality-of-life
- Robust signal-station tooling exposed in admin chat (#1408)
- Chat worker no longer drops pending tool calls when adding the bot to a group (#1462)
- Tool-prompt UX polish (#1454, #1485) and friendlier error messages on expired tool-call IDs (#1447)

---

Skipped from this list: structured-logger migrations, CI hot-fixes, infra refactors, and internal observability work — important, but not what your users see.
