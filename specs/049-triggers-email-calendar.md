# Triggers for email and calendar

**Status: design only. Nothing here is built.** The owner asked to hold the
build. What is agreed: email comes by Gmail push, calendar by a gentle poll,
and the first version only reads and reports.

## 1. What the owner gets

"When X happens in my email or calendar, do Y and tell me."

- "When my accountant emails, tell me the amount and the due date."
- "When a meeting is added for tomorrow morning, tell me tonight."
- "30 minutes before a meeting with someone outside my company, brief me."

An **email trigger** has: the account, a sender filter (an address or a
domain, optional), subject words (optional), a condition in plain words
(optional), and the instruction.

A **calendar trigger** has: the account, when it fires (an event was added or
changed, or N minutes before it starts), title words (optional), a condition
in plain words (optional), and the instruction.

Every trigger has: on or off, once or repeat, and a cooldown.

The owner makes one in the Watchers tab of the Tasks page, which gains a
Source picker (WhatsApp, Email, Calendar). No new page. He can also ask in
chat, and ask for the list.

## 2. How it works

### 2.1 Email: Gmail push, no polling

Nothing is asked of Gmail until mail arrives.

1. Gmail publishes a small notice to a Pub/Sub topic in the Google Cloud
   project that owns the OAuth client. The notice holds the mailbox address
   and a history number. It holds no mail text.
2. Pub/Sub pushes the notice to a new endpoint on the API,
   `POST /hooks/gmail`. The endpoint does nothing until it has verified
   Google's signed token (section 4).
3. The agent waits 30 to 60 seconds for the burst to settle. Then it asks
   Gmail once what changed since the last notice (`users.history.list`,
   2 quota units).
4. For a trigger with a sender or subject filter, it asks Gmail for only the
   new messages that match (`users.messages.list` with a query, 5 units) and
   reads the headers of the hits alone. For a trigger with only a condition
   in words, it reads the headers of each new message (`users.messages.get`,
   `format: metadata`, 20 units each), 10 at most per burst. It never reads a
   body at this stage.
5. A watch exists on an account only while that account has an active email
   trigger. It covers the inbox alone (`labelIds: ['INBOX']`,
   `labelFilterBehavior: 'INCLUDE'`). Google ends a watch after 7 days and
   recommends a daily renewal. So it is renewed once a day, at a random
   minute. It is stopped (`users.stop`) when the last email trigger on that
   account goes. The daily renewal also does one catch-up read, which covers
   a gap in Pub/Sub.
6. If push is not set up, email triggers stay off and the page says so. There
   is no silent fallback to polling.

### 2.2 Calendar: a gentle poll

Calendar push exists, but it needs one watch per calendar and each expires
within a week. It can come later and use the same endpoint.

- One `events.list` per account every 30 minutes, give or take 25%, with a
  sync token so Google returns only what changed.
- Only for an account that has an active calendar trigger.
- "N minutes before an event" fires from a timer set on the device from that
  list. It is exact, it survives a restart, and it needs no extra calls.
- The poll reads only the calendars ticked in Settings. It calls the tool
  from code, so it sets `singleEvents` itself where it lists a day, and never
  next to a sync token (Google refuses the pair).

### 2.3 Matching, in two steps

1. **In code, free:** sender, subject words, title words, the time window,
   and "already seen".
2. **A cheap model check, only when the owner wrote a condition in words.**
   It is built like the approval guardian. The owner's condition is the
   trusted part. The item's sender, subject and snippet (or title, time and
   attendee domains) go in a fenced block marked as someone else's text. The
   answer is a fixed JSON shape: match or not, and how sure. It has 8
   seconds. Any failure means no fire, and the item is tried again next time,
   three times at most. About $0.0003 per item, under its own cost tag
   `trigger_check`.

### 2.4 What a fired trigger runs

- It runs as a scheduled job (`source: 'scheduler'`, `jobName: trigger_<id>`)
  on FLASH. That choice gives it the run-time tool list check, approval cards
  on the owner's channel, the job's report path, and a row in Job History.
- It starts marked as having read third-party text, before its first call.
- The matched item reaches it as fenced data, never as instructions. It may
  open the full email through the Gmail tool, where it arrives in the usual
  untrusted envelope.
- Its answer goes to the owner once, through the delivery ledger, with
  retries. `[SILENT]` means it had nothing to say.

## 3. Setting up Gmail push from Settings

Goal: the owner types nothing. He copies one script, runs it once, and the
page turns green by itself.

### 3.1 What Deedee already knows

| Value | Where it comes from |
|---|---|
| The push URL | `SOCKET_URL` is the API's public address in the two-subdomain setup (README, Authentication Setup). The URL is `<SOCKET_URL>/hooks/gmail`. With one subdomain it is `WEB_ORIGIN` plus the path the reverse proxy sends to the API; the field can be edited. |
| The Google Cloud project | A connected account's `client_id` starts with the project **number** of the OAuth client. Gmail only publishes to a topic in that same project. Accounts that share one OAuth client share one topic and one subscription. |
| Which accounts need a watch | The ones with an active email trigger. |
| Everything else | Fixed names: topic `deedee-gmail`, subscription `deedee-gmail-push`, service account `deedee-push`. |

So nothing is left for the owner to look up.

### 3.2 The card

Settings → Interfaces → Google Workspace gains a card, **Email triggers
(Gmail push)**, one per OAuth project:

1. **The push URL**, pre-filled, with a self-test. The API asks its own public
   address for `GET /hooks/gmail/ping`, which answers a fixed body with no
   login. A redirect or a 401 there means the reverse proxy asks for a login
   on that path, and the card says so: "Let `POST /hooks/gmail` through
   without the proxy's own login." A failed self-test is a warning, not a
   stop: some home networks cannot reach their own public address from
   inside.
2. **The script**, pre-filled (3.3), with a Copy button and an
   **Open Cloud Shell** link (`https://shell.cloud.google.com/?show=terminal`).
   Cloud Shell is signed in already and has `gcloud`. The script takes about
   20 seconds.
3. **Waiting for the test message.** The script's last line publishes one
   message that carries a one-time code. When it arrives, the card turns to
   **Connected** by itself, over the socket.

Connected shows: the topic, the service account, the time of the last push,
pushes in the last 24 hours, the last error, and each account's watch with
its expiry. Two buttons: **Send a test push** (a one-line command with a
fresh code) and **Disconnect** (stops every watch, forgets the settings, and
prints the two `gcloud` commands that delete the cloud side).

### 3.3 The script

The card fills in the three values at the top. The code is 32 random hex
characters, shown only on this page, valid for 30 minutes, usable once.

```bash
PROJECT_NUMBER=123456789012                          # from the OAuth client id
PUSH_URL=https://api.example.com/hooks/gmail         # from SOCKET_URL
ENROL_CODE=0123456789abcdef0123456789abcdef          # one-time, 30 minutes

set -euo pipefail
PROJECT_ID=$(gcloud projects describe "$PROJECT_NUMBER" --format='value(projectId)')
gcloud config set project "$PROJECT_ID" >/dev/null
SA="deedee-push@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable pubsub.googleapis.com
gcloud pubsub topics describe deedee-gmail >/dev/null 2>&1 \
  || gcloud pubsub topics create deedee-gmail

# Gmail may publish to the topic.
gcloud pubsub topics add-iam-policy-binding deedee-gmail \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher >/dev/null

# The identity Pub/Sub signs each push with. It holds no roles.
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create deedee-push --display-name="Deedee Gmail push"
# Pub/Sub's own service agent must be allowed to sign as it.
gcloud beta services identity create --service=pubsub.googleapis.com >/dev/null 2>&1 || true
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null

gcloud pubsub subscriptions describe deedee-gmail-push >/dev/null 2>&1 \
  || gcloud pubsub subscriptions create deedee-gmail-push \
       --topic=deedee-gmail \
       --push-endpoint="$PUSH_URL" \
       --push-auth-service-account="$SA" \
       --push-auth-token-audience="$PUSH_URL" \
       --ack-deadline=10 --message-retention-duration=10m \
       --expiration-period=never \
       --min-retry-delay=10s --max-retry-delay=600s

# Tell Deedee it is done. This is what turns the card green.
gcloud pubsub topics publish deedee-gmail \
  --message="{\"deedee\":\"enrol\",\"code\":\"${ENROL_CODE}\",\"topic\":\"projects/${PROJECT_ID}/topics/deedee-gmail\"}"
echo "Done. Look at the Settings page."
```

The script is safe to run twice: each step checks before it creates.
Retention is 10 minutes on purpose. After an outage Deedee gets no flood of
old notices; the daily catch-up read covers the gap.

### 3.4 How the test message sets everything

The push for the test message reaches `POST /hooks/gmail` like any other.

1. The endpoint verifies Google's signature and that the audience is its own
   push URL (section 4). That proves the call came through a Pub/Sub push
   subscription aimed at this URL. It does not prove whose: anyone can aim
   their own subscription here.
2. The one-time code proves whose. It is compared in constant time, and
   burned on the first try that carries a valid signature, right or wrong.
3. Deedee then **learns** the rest from that one verified call: the service
   account's address from the token's `email` claim, the project from the
   envelope's `subscription` field, the topic from the message. It stores
   them and pins them. From then on a push must carry that exact service
   account, or it is refused.
4. It calls `users.watch` for each account that has an active email trigger.
   A watch that succeeds proves Gmail may publish to the topic. One that
   fails shows Google's own error on the card.

No settings are typed. None of the stored values is a secret.

### 3.5 Considered and not chosen

- **Deedee does it all after one Google sign-in.** It would need a sign-in
  flow the app does not have (accounts are connected by pasting a token
  file), and scopes that can create service accounts, which means
  `cloud-platform`. The device would hold cloud-admin rights, even if
  briefly. A 20-second script the owner can read is the better trade.
- **A secret in the push URL, with no signed token.** Simpler, and it needs no
  service account. But the secret lands in every reverse-proxy log. The
  signed token needs no secret at all.
- **Typing the three settings by hand.** That was the first plan. The test
  message makes it needless.

## 4. The endpoint

`POST /hooks/gmail` is a new public door on `apps/api`. It sits before the
session and bearer checks because it has its own.

- Body limit 16 KB, JSON only. Anything else: 400.
- `Authorization: Bearer <JWT>` is verified with `jose` (already a dependency)
  against Google's keys (`https://www.googleapis.com/oauth2/v3/certs`, cached):
  issuer `https://accounts.google.com` or `accounts.google.com` (Google
  documents both), audience equal to the stored push URL, `email_verified` true, `email` equal to the pinned service account,
  60 seconds of clock slack. Before enrolment there is no pinned account, and
  the only message accepted is a valid enrolment (3.4).
- A bad or missing token: 401, and nothing else runs. No log line carries the
  token or the body.
- A good token: answer 204 at once. The handler only hands
  `{ emailAddress, historyId }` to the agent over the internal route, with
  the internal token. It never works inline.
- An address that is not a connected account with an active email trigger:
  204 and dropped, so Pub/Sub does not retry.
- Replays: the last 1,000 Pub/Sub `messageId`s are remembered, and a notice
  whose `historyId` is not above the account's cursor is dropped.
- A global budget of 60 accepted pushes a minute. Over it: 429, and Pub/Sub
  backs off by itself. Gmail sends at most one notice a second per mailbox,
  and a notice only says "look now": the history read goes by the stored
  cursor, so a dropped notice loses nothing as long as a later one arrives.
- `GET /hooks/gmail/ping` answers `{ "deedee": true }`. It exists for the
  self-test and tells a stranger nothing new.

The most a valid push can cause is "look at this account's history now".

## 5. Safety

An email trigger fires on text a stranger wrote, at a time the stranger
chooses. So:

- **The first version only reads and reports.** The tool list is fixed and
  written by hand: the trigger account's one Gmail or Calendar tool,
  `getFact`, `searchMemory`, `searchHistory`, `getPerson`, `searchPeople`,
  `googleSearch`. No `sendMessage`, no reminders or jobs, no memory or vault
  writes, no sub-agents, no shell, no browser. Each of those runs with no
  card in a run that read untrusted text, and none leaves a mark the next
  run could see.
- **The tool scoper does not build the list.** It returns "no list" when it
  fails, and it adds every MCP tool it cannot place.
- **The model check decides one thing:** match or not. It never picks the
  instruction, the tools, the recipient or the time.
- **Caps, all enforced in code.** 10 items checked per burst. Per trigger: a
  cooldown (10 minutes for email; calendar "before" is keyed per event) and
  20 fires a day. 50 fires a day across all triggers. Over a cap, the trigger
  pauses and the owner hears once.
- **Failure is quiet.** A throw, an `error` field, or an error inside the
  tool's output all count. One alert per account per 6 hours. After three
  failures in a row the account is skipped for 30 minutes. An expired login
  stops that account until the owner reconnects it. No retry loop.
- **The WhatsApp watcher path is fenced off.** Today it reads every active
  row on every inbound chat message, and one branch is a substring test. An
  address-shaped row fired from an unrelated group message in a test. The
  matcher will look at WhatsApp rows only.
- **Switch:** `TRIGGERS=0`, or the system job's toggle in the Tasks page.

## 6. Gentle on Google

These are the owner's personal and work accounts, so the design spends as
little as it can. Google's own numbers, read from its quota pages on
2026-09-20:

| | Limit | What this design uses |
|---|---|---|
| Gmail | 6,000 quota units per minute per user; 80,000,000 a day per project before any charge | about 100 a day for the watch, 2 per burst, 5 per filtered trigger per burst, 20 per message read |
| Calendar | 600 requests per minute per user | about 48 a day per account |
| Pub/Sub | the first 10 GiB a month are free | a notice is under 1 KB |

Over a limit, Google answers 403 or 429 and asks the caller to back off.
Neither quota page mentions suspending an account for polling. The real
risks are a bug that loops, and retries against an expired login. Section 5
closes both.

- **No trigger on an account, no call to it, and no watch on it.**
- **A work account's real question is its admin, not Google.** The calls show
  in the Workspace audit log as activity from the OAuth client. With push,
  notices about the work mailbox (its address and a history number, no
  content) pass through the Cloud project that owns that client. If the
  domain is not the owner's, its policy counts for more than Google's limits.
- On a 403 or 429, that account's interval doubles, up to 6 hours, and the
  owner hears once.
- A hard cap of 300 calls per account per day. At the cap it stops until the
  next day and says so once.

## 7. Build plan: three pull requests

1. **Storage and the matcher fence.** Two new columns on the `watchers`
   table, `source` and `config`. The WhatsApp matcher reads WhatsApp rows
   only. The routes, the form with its Source picker, `addWatcher` gains the
   new fields, and a new `listWatchers` tool.
2. **The check, the fired run, and the calendar poll.** The system job, sync
   tokens, the caps, the cheap model check, the report-only run, the alerts.
   Tests use a fake Google tool.
3. **Gmail by push.** The verified endpoint in `apps/api`, enrolment by test
   message, the agent's history read, the watch's life, and the Settings
   card with its script.

Each gets a multi-lens review with adversarial checks. None is merged by
the author.

## 8. Not in the first version, on purpose

- **Triggers that act** (send, reply, book, remind). In a run that read a
  stranger's text, every outward step raises a card, and a 3am card is read
  in the morning. This can come later, per trigger, with the tools the owner
  ticks.
- **Home Assistant and cron sources.** Node-RED and `scheduleJob` cover them.
- **A dry-run page.** `listWatchers` and Job History are enough to start.
- **Calendar push.**

## 9. Open points, to settle while building

- The sender and subject headers did not come back from `messages.get` when
  `metadataHeaders` went through the Google tool as a list. Find the form the
  tool expects, or ask for all headers.
- The name of the argument that carries a request body in the Google tool's
  compact mode, which `users.watch` needs. The CLI itself takes `--json`.
- That a Gmail query accepts `after:` with a time in seconds, through this
  tool. `newer_than:2d` is proven.
- That `users.watch` accepts the topic the script made. Google's reference
  says the topic must sit in the OAuth client's project; the first call will
  confirm it.
- An organisation policy that restricts sharing by domain can refuse the
  grant to `gmail-api-push@system.gserviceaccount.com` (Google's guide says
  so). The script will stop there with Google's error. The fix is an
  exception for that one account.
- The script's flags were checked against Google's `gcloud` reference on
  2026-09-21. It has not been run yet.

## 10. Evidence

- **A code map** of how watchers work today, reading Gmail and Calendar from
  code with no model in the loop, starting a run and reporting once, the
  guardian's check as a pattern, the page and the tools, and the threat
  model.
- **Checks on the device, 2026-09-20 and 2026-09-21**, printing shapes and
  timings only, never content, through the real Google tool:
  - `users.messages.list` with a query: works, 0.6 to 0.8 s.
  - `users.messages.get` with `format: metadata`: works, 0.3 s, no body.
  - `events.list` with `updatedMin` and `singleEvents`: works, 0.5 to 1.0 s,
    and returns a sync token.
  - `events.list` with a time window: works, 0.3 to 0.5 s.
  - The Google CLI on the device has `users watch`, with `--params` and a
    `--json` body.
  - The connected accounts hold the read-only Gmail scope, which is enough
    for `watch`.
  - The connected accounts share one OAuth client, so one topic and one
    subscription serve them all.
  - The stored credentials hold no project id; the client id's number prefix
    is what names the project.
  - `SOCKET_URL` is set, so the push URL can be pre-filled.
- **Usage when this was written:** 2 WhatsApp watchers, 0 watcher runs in 30
  days. The feature must cost nothing when idle.
