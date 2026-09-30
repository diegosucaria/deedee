# Errands

An errand is one thing Deedee does for the owner with one person over
WhatsApp, writing from his own account in his voice. The design is in
`specs/050-errands.md`.

He asks in his own chat:

- "Pedile turno a Alice para el jueves" (`book`: agree a slot and add it to
  his calendar)
- "Preguntale a Bob si viene el sábado" (`ask`: ask and tell him the answer)
- "Decile a Carol que llego 10 minutos tarde" (`tell`: pass on a message)

The model finds the person with `searchContacts` and calls `startErrand`.
It never writes the message itself.

## Where the code is

| File | What it does |
|---|---|
| `apps/agent/src/services/errands.js` | The errand: start, the message hook, reading replies, deciding, the steps, the calendar, the sweep |
| `apps/agent/src/services/voice.js` | Writes each message in his voice, then cleans and checks it |
| `packages/shared/src/style-stats.js` | His style as numbers, computed by the interfaces service |
| `apps/agent/src/executors/errands.js` | The tools `startErrand`, `answerErrand`, `listErrands` |
| `apps/agent/src/routes/autopilot.js` | `/errands` routes for the web tab |
| `apps/api/src/routes/autopilot.js` | `GET /v1/autopilot/errands`, `GET /v1/autopilot/errands/:id`, `POST /v1/autopilot/errands/:id/cancel` |
| `apps/web/src/components/Errands.js`, `apps/web/src/lib/errands.js` | Autopilot → Errands: open and recent errands, their steps, Cancel |

## How it works

1. **Start.** `startErrand` reads the last 60 messages of his chat with that
   person and his style numbers. For `book` it checks his calendar for that
   day. `voice.js` writes the first message, and it goes out from his
   account (`session: 'user'`, `strictSession: true`: never from Deedee's
   number). If he never wrote to that person, he gets a card first.
2. **Replies.** In `agent.js`, a contact's message on his account reaches
   the errand before watchers and Autopilot. While an errand is open for a
   chat, they skip that chat. Messages wait 20 seconds for the rest of a
   burst (longer while the contact types). Voice notes are transcribed.
3. **Reading.** A Flash call with no tools fills a form: `offer`,
   `confirm`, `decline`, `question`, `answer` or `other`, with slots. Code
   keeps only real dates in the future.
4. **Deciding.** Code decides:
   - the contact confirms the slot he asked for, or (window mode) offers a
     free slot inside his window: Deedee answers on her own and books;
   - any other slot: a card for `answerErrand`, "sí" accepts it;
   - a question, a refusal, an unclear answer: a note asks him.
5. **Booking.** Code adds the event to his primary calendar with no guests.
   It uses the `gws_personal` calendar tool (`ERRANDS_CALENDAR_ACCOUNT`
   picks another), and skips an event that is already there.

He answers an errand in his chat. The turn context lists open errands, so
"sí", "decile a las 11" or "cancelalo" reach `answerErrand`.

## The voice

`voice.js` gives the model:

- the chat, marked as data;
- his notes from Autopilot → Style;
- his measured habits: how often he opens a question with "¿", ends with a
  period, how long his messages are, how many he sends in a row.

The interfaces service computes those numbers over his own one-to-one texts
(`GET /whatsapp/style-stats`) and returns numbers only. The agent keeps
them for a day in `agent_settings.owner_style_stats`.

After the model writes, code:

- removes an opening "¿" or "¡" and a final period when he almost never
  uses them;
- refuses links, phone numbers, emails, money, brackets, words aimed at an
  assistant, more than 160 characters or 2 messages, and a time other than
  the slot;
- lets a refused draft try once more with the reasons; a second refusal
  sends nothing.

## Limits

| Limit | Value |
|---|---|
| Open errands | 3, one per person |
| Messages it sends on its own | 4 per errand; then every step asks |
| All messages | 10 per errand |
| Gap between its own messages | 1 minute |
| Quiet hours | 22:00 to 08:00: a step waits until 08:00 |
| No answer | he hears after 4 hours; Deedee never writes again on her own |
| Life | until the slot's day, 7 days at most |
| Model calls | 20 per errand, then it pauses |

## Switches

- `ERRANDS=0`: no errand starts, the hook and the sweep stop. Read on every
  call.
- `ERRANDS_CALENDAR_ACCOUNT`: the Google account label whose calendar gets
  the bookings. Default `personal`.
- `communication_dry_run` (Settings): errands draft and send nothing.

## Approvals

Errands use the built-in approval service (`docs/security.md`, Errands):
his request in his own chat starts one with no card; his choices come as
cards for `answerErrand`; steps inside the scope he set run through the gate
with a one-time errand grant. The guardian does not decide errand steps.
