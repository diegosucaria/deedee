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
   person and his style numbers. It reads that exact chat (`exact=1`): a
   new number never reads another person's chat, even when the last digits
   match. For `book` it checks his calendar for that day, and a time the
   draft picks must be free. `voice.js` writes the first message, the
   message check reads it (see Safety), and it goes out from his account
   (`session: 'user'`, `strictSession: true`: never from Deedee's number).
   If he never wrote to that person, or two People share the name, he gets
   a card with the words first. An errand never writes to his own lines or
   to Deedee's number. A number shorter than 11 digits that his WhatsApp
   cannot place is refused: he gives the full number.
2. **Replies.** In `agent.js`, a contact's message on his account reaches
   the errand before watchers and Autopilot. While an errand is open for a
   chat, and until the booked slot (12 hours at most) after it books, they
   skip that chat. Messages wait 20 seconds for the rest of a burst (longer
   while the contact types). Voice notes are transcribed; a photo, or a
   voice note it cannot read, reaches him.
3. **Reading.** A Flash call with no tools fills a form: `offer`,
   `confirm`, `decline`, `question`, `answer`, `later` or `other`, with
   slots, and says whether the messages carry news for him. Code keeps only
   real slots at least 15 minutes ahead. An offer sooner than that ("venite
   ya") reaches him as too soon to accept.
4. **Deciding.** Code decides:
   - the contact confirms the slot he asked for on his day, and his
     calendar is free then: Deedee answers on her own and books. A range
     (window mode) never books on its own: every offer comes as a card that
     says whether it is inside his range (a slot inside it comes first).
     When he named no time, the start reply says which time the errand
     asked for. If he writes to the contact himself, the note says nothing
     was booked. Only until he decides otherwise:
     after his "no" to a card, any step of his (even one that failed to go
     out), a step of his on hold, a pause, or her own "no tengo lugar", the errand acts on nothing
     by itself (`auto_ok`) until a slot he proposed goes out. A card or a note
     he has not answered yet does not change this: her later yes to his own
     slot still books;
   - any other slot: a card for `answerErrand`, "sí" accepts it. The card
     says why it asks: his calendar is busy then, the slot is inside or
     outside his range, or the day or time was one the draft picked, not he;
   - a question, a refusal, an unclear answer: a note asks him;
   - small talk: nothing; news: a note. A note that asks him says so when
     a step that waited, or one he asked for, did not go out;
   - her yes after something he has not answered yet (news such as a
     price, a photo or a file, a question of hers, a voice note it could
     not read) comes as a card that says why, never the automatic thanks.

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
card or a note (a voice note whose audio never arrived counts too). A file,
a location or a contact card she sends counts as her answer; reactions,
missed calls and edits do not. News or
a photo in the same burst as an answer reaches him in a note of its own.
Her yes that waits for 08:00 stays in view (`held_yes`): the model's context
says so, every note that drops it names it, and words of his to her
meanwhile do not drop it silently. Her "no tengo lugar", her "me fijo" (he is
told), her newer offer, his "no" to its card, or a step of his that picks
another slot ends it. Her "me fijo", even with a photo or news, takes that
slot off the table and takes back any card that would accept a slot of hers
(the errand's, or his own "aceptale"); he hears what it took back, and the
errand waits for her again. An offer of hers whose card lapsed is no longer
taken as settled either. A card of his for another slot or his words stays
the live question, with no note. "Tengo a las 11, igual me fijo si se libera
a las 10" brings a card for 11:00, never a booking on its own; a photo, news
or an unreadable voice note with it still reaches him. The reader lists only
a slot she firmly offers, never one she is still checking. A card that lapsed
at night sends no "sigue esperando" note once her newer words were read.
His "no" to her offer takes it off the table. Her yes that the errand is about to
accept on its own stays on record until it is booked, so a pause or a
takeover still names it. After a
booking, her "me fijo" reaches him too. A window of 00:00 to 00:00 means any
time on its days. Otherwise its hours hold on each day: "jueves o viernes a
las 10" (10:00 to 10:00) takes 10:00 only. Hours that pass midnight hold each
night, up to the morning after its last night. From one afternoon to a
morning after 06:00 the next day ("jueves a la tarde o viernes a la
mañana") is one stretch, shown with both ends. A first message may name only the
window's days. While a step he asked for waits for the contact's
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

The model writes like him, from his chat with that person, in the language
he uses there. `voice.js` gives it:

- the chat, marked as data, his lines as examples;
- up to five of his past replies to the same kind of moment (her line that
  offered or confirmed a time, then his answer), her line marked as data;
- his notes from Autopilot → Style;
- his measured habits: how often he opens a question with "¿", ends with a
  period, how long his messages are, how many he sends in a row.

The interfaces service computes those numbers over his own one-to-one texts
(`GET /whatsapp/style-stats`) and returns numbers only. The agent keeps
them for a day in `agent_settings.owner_style_stats`.

For the automatic accept or thanks it first reuses his own words: a short
line of his (40 characters or less, not a question) that answered her
offer or yes before, with the hour set to the slot's ("dale, 11 voy"
becomes "dale, 10 voy"). No model writes it. A line that says no, adds a
condition or cancels is never reused. With no such line, the model writes
one.

After the text is written, code:

- removes an opening "¿" or "¡" and a final period when he almost never
  uses them;
- drops invisible marks (format and default-ignorable code points; a joiner
  between two emoji stays);
- refuses links, phone numbers, emails, brackets around words, words aimed
  at an assistant, commands to Deedee, more than 160 characters or 2
  messages, a time or day other than the slot's, a number his words or the
  slot do not have, and money unless his own words mention it; an accept
  must name its time. These word lists read Spanish and English; they are a
  cheap first filter, and the message check below reads the meaning in any
  language;
- lets a refused draft try once more with the reasons; a second refusal
  sends nothing.

## Safety

Nothing goes out from his account that he did not ask for or see:

- **Who.** Only his own typed chat starts or answers an errand. A job, a
  watcher, a sub-agent, a contact's chat or a voice call is refused at the
  gate, with no card.
- **The message check.** Before any words he has not seen go out (the
  first message, the automatic accept or thanks, a step of his the voice
  wrote), the guardian's `checkMessage` reads them. It sees the step, the
  slot or window, his words and the draft, never her messages, so she
  cannot steer it. It says ok only when the draft does exactly what the step
  allows: a thanks that also cancels, agrees to a price, names another day,
  makes a promise or brings in someone else is held. Held, failed or no
  guardian: nothing goes out, and he gets a card with the exact words and
  the reason ("¿Le mando esto a Alice? «…»"). His yes sends exactly those
  words. Words he already saw (a draft he asked for, a card) are not
  checked again.
- **What goes out by itself.** Only the accept or thanks for the exact day
  and time he asked for, by day, with his calendar free. A range never books
  by itself.
- **His reply to a card.** A plain "sí", "no", "dale", "👍" (also "siii",
  "👍🏻", "dale👍") decides it. Other words ("aceptale las 10:30", "de una")
  go to the guardian's `readReply`, which sees only what the card does,
  written by code, and his reply. Only a clear yes or no decides the card;
  "jaja", "mil gracias" or "dale pero a las 11" decide nothing. A short yes
  that no card took never runs anything or writes to anyone, except sending
  a draft he saw before it, for the same day and time, when no card reached
  him after that draft.
- **One person, once.** A start runs under a lock per person; a second start
  for the same person in the same run is refused and says what went out. A
  new start for someone an errand wrote to in the last 10 minutes, with no
  word from her since, asks first. Words she got from his account in that
  time never go out again.
- **Stops that hold.** A cancel takes effect before a running step sends.
  Before each part of a message the errand reads the chat again; if he
  wrote to her himself, it stops. Past its end it never acts.
- **Others stay out.** While an errand holds a chat, watchers and Autopilot
  do not write to that person; Autopilot drops a reply it held from before.
- **Limits.** See below. A failed send is never retried by itself.

## Limits

| Limit | Value |
|---|---|
| Open errands | 3, one per person |
| Messages it sends on its own | 4 per errand; then every step asks |
| All messages | 10 per errand |
| Gap between its own messages | 1 minute |
| Quiet hours | 22:00 to 08:00: a step waits until 08:00 |
| No answer | he hears after 4 hours; "me fijo" or small talk is no answer, so the wait counts from their last word (four hours of her day: the night does not count), and he hears by two hours before the slot (the evening before, when that falls at night; for a window, before its last day's start, or its end once that start passed); his words after her "no" that ask nothing wait for no answer, even when small talk came after her "no" or he adds another such line; Deedee never writes again on her own |
| Life | until the slot's day, 7 days at most; an end in quiet hours moves to 21:55 (a late slot keeps its evening); past its end an errand closes at once, and a note held by quiet hours goes out at 08:00. He hears at the start when the errand ends before the day |
| Model calls | 20 per errand, 40 for his own steps and once he answers a paused errand |
| Voice notes | 60 seconds to transcribe, then it counts as unreadable |
| Contact messages | 60 per errand (every message, not one burst), then it pauses |
| Model checks | one message check per message he has not seen; one reply read per card reply the word list does not decide |

## Switches

- `ERRANDS=0`: no errand starts, the hook and the sweep stop; a cancel
  still works. Read on every call.
- `ERRANDS_CALENDAR_ACCOUNT`: the Google account label whose calendar gets
  the bookings. Default `personal`.
- `communication_dry_run` (Settings): errands draft and send nothing.
- `VOICE_OWN_REPLY=0`: the automatic accept or thanks never reuses his past
  reply; the model writes it. Read on every call.
- `CARD_REPLY_READ=0`: his replies to a card are not read by the guardian;
  only the plain yes and no words decide it. Read on every call.
- The message check has no switch: turning it off would let unseen words go
  out unchecked.

## Approvals

Errands use the built-in approval service (`docs/security.md`, Errands):
his request in his own chat starts one with no card; his choices come as
cards for `answerErrand`; steps inside the scope he set run through the gate
with a one-time errand grant. The guardian never allows an errand step,
but its message check can stop one (a card instead), and its reply reader
reads his words to a card. Only his own chat starts or answers an errand: a
job, a watcher or a contact's chat is refused at the gate, with no card.
