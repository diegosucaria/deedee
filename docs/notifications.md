# Owner notifications and the delivery ledger

Everything the agent pushes to the owner on its own goes through one path:
`services/delivery-service.js`. It keeps a ledger (`notification_outbox` in
`agent.db`), retries refused sends, and tries the other owner channel when
the first one stays down.

Why: in Aug/Sep 2026 twenty notifications were lost while WhatsApp was down.
Each one made a single attempt; the only trace was the dashboard bell.

## What goes through it

| kind | source |
|---|---|
| `job_notification` | scheduler smart notifications (`_processSmartNotification`) |
| `reminder` | `setReminder` jobs, also late ones found at boot |
| `system_alert` | `agent.deliverSystemAlert` (Slack token expiry, WhatsApp needs repair, ...) |
| `ask_user` | questions the `askUser` tool sends |
| `watcher` | watcher replies redirected to `admin_chat_id` when the interface refused them |
| `reply` | a normal chat reply the interface refused (`_deliverReply`) |

Channels: `whatsapp`, `telegram`, `web`, `slack`. The service builds the id
each channel expects: WhatsApp gets `<digits>@s.whatsapp.net` unless the
target already carries an `@`, Telegram needs a numeric chat id.

## Owner channel

`resolveOwnerTarget()` reads `notification_channel` (`whatsapp` or
`telegram`) from settings and picks the id that channel needs:

- WhatsApp: `owner_phone` (or `MY_PHONE`) as a phone JID.
- Telegram: the first id in `ALLOWED_TELEGRAM_IDS`.

When the chosen channel has no id, the other one is used. Before this
change the scheduler and `askUser` sent to `<owner_phone>@s.whatsapp.net`
even with `notification_channel = telegram`.

## Life of a row

```
deliver() -> one attempt now
  ok   -> status sent, delivered_via = channel
  fail -> status failed, attempts = 1, next_attempt_at = now + 1 min
worker tick (every 60 s) -> claims due rows -> one attempt each
  fail -> backoff 1 min, 5 min, 15 min, 1 h, 1 h
  sixth failure -> status dead + one dashboard notification (delivery_dead)
```

Fallback: after the second failure on the primary channel the same payload
goes once through the other owner channel (Telegram when
`ALLOWED_TELEGRAM_IDS` is set, WhatsApp when `owner_phone` is set). System
alerts ask for the fallback right after the first failure. If the fallback
accepts, the row is `sent` and nothing is retried; the owner never gets two
copies. If the fallback also fails, only the primary keeps retrying. A
message for someone else (a reply to a contact) never jumps channels.

Dedupe: the same kind, target and content within 10 minutes is queued once.
`askUser` turns this off (two equal questions are two questions).

Expiry: `askUser` rows carry `expires_at`; a row past it dies instead of
being sent late.

Boot: `loadJobs` no longer drops one-off reminders that came due while the
process was down. Those less than 24 h overdue go out with a `(late)`
marker; older ones are dropped as before.

The message id equals the row id, so the WhatsApp thread mirror stores one
copy however many attempts it took. A refused send is not mirrored.

## Inspecting it

- Dashboard: `/system/notifications`, section "Undelivered". Pending, failed
  and dead rows with a Retry button; "Show sent" lists the rest.
- API: `GET /v1/notifications/outbox?limit=50&status=failed` (rows and
  counts), `POST /v1/notifications/outbox/:id/retry`. The agent serves the
  same under `/internal/notifications/outbox` behind `DEEDEE_INTERNAL_TOKEN`.
- SQL, inside the agent container:

```sh
sqlite3 /app/data/agent.db "SELECT status, COUNT(*) FROM notification_outbox GROUP BY status;"
sqlite3 /app/data/agent.db "SELECT id, kind, channel, status, attempts, next_attempt_at, last_error FROM notification_outbox WHERE status != 'sent' ORDER BY created_at DESC LIMIT 20;"
```

Logs carry the `[Delivery]` prefix: one warning per failed attempt, one
line per fallback, one error per dead row.

## Tuning

Constants live at the top of `services/delivery-service.js`: `BACKOFF_MS`,
`MAX_ATTEMPTS` (6), `TICK_MS` (60 s), `DEDUPE_WINDOW_MS` (10 min),
`FALLBACK_AFTER_FAILURES` (2). Sent and dead rows older than 30 days go
with `db.cleanupOutbox(days)`.
