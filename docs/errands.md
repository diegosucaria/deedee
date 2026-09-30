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
   day, and a time the draft picks must be free. `voice.js` writes the first
   message, and it goes out from his account (`session: 'user'`,
   `strictSession: true`: never from Deedee's number). If he never wrote to
   that person, he gets a card first. An errand never writes to his own
   lines or to Deedee's number.
2. **Replies.** In `agent.js`, a contact's message on his account reaches
   the errand before watchers and Autopilot. While an errand is open for a
   chat, and until the booked slot (12 hours at most) after it books, they
   skip that chat. Messages wait 20 seconds for the rest of a burst (longer
   while the contact types). Voice notes are transcribed; a photo, or a
   voice note it cannot read, reaches him.
3. **Reading.** A Flash call with no tools fills a form: `offer`,
   `confirm`, `decline`, `question`, `answer`, `later` or `other`, with
   slots, and says whether the messages carry news for him. Code keeps only
   real slots at least 15 minutes ahead.
4. **Deciding.** Code decides:
   - the contact confirms the slot he asked for on his day, or (window
     mode) offers a slot inside his window, and his calendar is free then:
     Deedee answers on her own and books. Only until he decides otherwise:
     after his "no" to a card, any step of his (even one that failed to go
     out), a step of his on hold, a pause, or her own "no tengo lugar", the errand acts on nothing
     by itself (`auto_ok`) until a slot he proposed goes out. A card or a note
     he has not answered yet does not change this: her later yes to his own
     slot still books;
   - any other slot: a card for `answerErrand`, "sí" accepts it. The card
     says why it asks: his calendar is busy then, the slot is outside his
     window, or the day or time was one the draft picked, not he;
   - a question, a refusal, an unclear answer: a note asks him;
   - small talk: nothing; news: a note. A note that asks him says so when
     a step that waited, or one he asked for, did not go out.

   Every card also says when his calendar is busy at that slot, or could
   not be read. If his calendar cannot be read at the start, the errand
   still asks for his usual time; her yes then comes to him as a card.
5. **Booking.** Code adds the event to his primary calendar with no guests.
   It uses the `gws_personal` calendar tool (`ERRANDS_CALENDAR_ACCOUNT`
   picks another), and skips an event that is already there: one with the
   errand's title or its note (`(errand #N)`) at that start, or his
   watcher's event naming the person in full. A name inside another word
   never counts.

Notes and cards call an errand a "pedido" in Spanish. Notes that can wait
never go out between 22:00 and 08:00. A card or a note about the contact's
reply goes out at once, at any hour: the slot may not wait. A step inside
his scope that would have to wait for 08:00 past its own slot (a table
tonight) comes to him as a card at once instead.

A voice note it cannot read never lets the errand answer on its own, even
when other messages in the same burst say yes: the step comes to him as a
card or a note (a voice note whose audio never arrived counts too). News or
a photo in the same burst as an answer reaches him in a note of its own.
Her yes that waits for 08:00 stays in view: the model's context says so,
and words of his to her meanwhile do not drop it silently. While a step he asked for waits for the contact's
new words to be read, or waits on a card of his (or that card lapsed or was
dropped, and nothing went out since), the errand accepts nothing on its own;
a card, note or pause that drops his step names it. An `ask` errand ends on her answer,
a photo, a voice note it could not read or a reply the reader could not
take in included (never on a question of hers or a "me fijo"), so it no
longer holds her chat, and a follow-up question starts an errand of its own; a step of his that waited is named, and his own
words can still go to her with `sendMessage`. A step on a closed errand gets
no card. News or a photo goes out before the card it came with, so the card
stays the newest question.

A paused errand keeps the chat, so his watcher does not book what the
errand may still book. When the contact writes to a paused errand, he hears
it once per pause; no model reads it. When he answers a paused errand, it
goes on, and his step goes out.

He answers an errand in his chat. The turn context of his own chat lists
open errands, so "sí", "decile a las 11" or "cancelalo" reach
`answerErrand`. "cancelar" on an errand's card cancels the errand. If he
writes to the person himself, the errand steps aside and his watchers see
the chat again; a paused errand notices this too. If the contact had
confirmed a slot that was still waiting to be booked (say, overnight), the
note says it is not on his calendar. A message Deedee sent from his account
(a greeting job) is not him writing. Notes and cards come in his language
(Spanish when his request is).

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
- refuses links, phone numbers, emails, brackets around words, words aimed
  at an assistant, commands to Deedee, more than 160 characters or 2
  messages, and a time other than the slot; money only when his own words
  mention it; an accept must name its time;
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
| No answer | he hears after 4 hours; "me fijo" or small talk is no answer, so the wait counts from their last word; Deedee never writes again on her own |
| Life | until the slot's day, 7 days at most; an end in quiet hours moves to 21:55 (a late slot keeps its evening); past its end an errand closes at once, and a note held by quiet hours goes out at 08:00. He hears at the start when the errand ends before the day |
| Model calls | 20 per errand, 40 for his own steps and once he answers a paused errand |
| Voice notes | 60 seconds to transcribe, then it counts as unreadable |
| Contact messages | 60 per errand, then it pauses |

## Switches

- `ERRANDS=0`: no errand starts, the hook and the sweep stop; a cancel
  still works. Read on every call.
- `ERRANDS_CALENDAR_ACCOUNT`: the Google account label whose calendar gets
  the bookings. Default `personal`.
- `communication_dry_run` (Settings): errands draft and send nothing.

## Approvals

Errands use the built-in approval service (`docs/security.md`, Errands):
his request in his own chat starts one with no card; his choices come as
cards for `answerErrand`; steps inside the scope he set run through the gate
with a one-time errand grant. The guardian does not decide errand steps.
Only his own chat starts or answers an errand: a job, a watcher or a
contact's chat is refused at the gate, with no card.
