# Errands

**Status: built in PR "feat(errands)".** The owner agreed the design, the
approval model and the limits on 2026-09-30.

## 1. What the owner gets

He asks in his own chat, and Deedee does it from his WhatsApp, in his voice:

- "Pedile turno a Alice para el jueves" (book a slot)
- "Preguntale a Bob si viene el sábado" (ask a question)
- "Decile a Carol que llego 10 minutos tarde" (pass on a message)

Deedee writes to that one person, waits for the answer, asks him only when
a choice is his, and puts an agreed slot on his calendar.

Three goals:

- `book`: agree a time slot with a person (a barber, a clinic that books by
  WhatsApp) and add it to the owner's calendar.
- `ask`: ask one question and tell the owner the answer.
- `tell`: pass on a message. Nothing to wait for.

Two modes, for `book` only:

- `ask` (default): Deedee accepts, on her own, only the slot the owner asked
  for. Any other slot is his choice.
- `window`: the owner gives a window ("any free slot Thursday 9 to 12").
  Deedee accepts an offer inside it on her own when his calendar is free.

`send: false` only drafts the first message and shows it. Nothing goes out.

## 2. Where it sits

- **Watchers listen.** A contact writes, Deedee reacts. They never write as
  the owner.
- **Autopilot talks as the owner.** It drafts a reply to whatever comes in.
  It has no goal and no tools.
- **An errand gets one thing done.** It writes as the owner, to one person,
  for one goal, inside his limits. Then it ends.

An errand is its own service, `apps/agent/src/services/errands.js`, next to
Autopilot's `impersonation.js`, with a tab in Autopilot. It takes a
contact's message at the same point in `agent.js` where watchers and
Autopilot take it, and before them. While an errand is open for a chat, that
chat's watchers and Autopilot skip the contact's messages, so nothing books
a slot twice.

It is not a watcher. A watcher run is a full agent run with every tool,
started by a contact's text: the most power on the least trusted input. An
errand's model calls have no tools. They read and write text; code decides
and acts.

## 3. The flow

```
owner (his chat): "pedile turno a Alice para el jueves"
  startErrand          contact fixed, goal, slot or window, end date
  voice                reads the chat: his style, his usual time
  calendar             is he free then?
  first message        goes out; he gets a note with the exact text
contact answers (text or voice note)
  claim                the errand takes the message first
  read                 a model with no tools fills a fixed form
  decide (code)        inside his scope -> act; else -> ask him
  act                  reply in his voice, add the event, tell him
```

States:

| State | Meaning |
|---|---|
| `waiting_contact` | A message went out; waiting for the contact |
| `waiting_owner` | A choice is his: a card or a question waits for him |
| `paused` | A limit was hit or a message could not go out. It keeps the chat (no watcher books meanwhile). If the contact writes, he hears it once; if he writes to them himself, it steps aside. His next step on it makes it live again |
| `done`, `cancelled`, `expired`, `failed` | Closed |

A `tell` errand closes as soon as its message goes out. When he writes in
the chat himself, the errand closes (`cancelled`) and hands the contact's
messages back to his usual rules, so his watcher sees them as before. A
message Deedee sent from his account (a job, a greeting) is not him writing.

After a booking, the errand keeps the contact's messages until the slot, 12
hours at most. Small talk stays quiet; anything else reaches him as a note.
His watchers skip that chat meanwhile, so nothing books the slot twice.

## 4. The voice

`apps/agent/src/services/voice.js` writes every errand message. The same
module can serve Autopilot and the greetings later.

What it reads:

1. The last 60 messages of that chat, both sides, from `/whatsapp/history`
   (the owner's own session). The owner's lines are the examples.
2. His notes on this person (Autopilot → Style, `people.metadata.style_profile`)
   and his global notes (`user_style_profile`).
3. His style numbers (`owner_style_stats`): computed by the interfaces
   service over his own one-to-one texts. Numbers only, no text: how often a
   question opens with `¿`, how often a message ends with a period, message
   length, how many short messages he sends in a row, emoji and laughter.
4. The step to write: ask for a slot, accept one, propose another, decline,
   thank, ask a question, pass on a message.

A Flash call with no tools returns `{ text, slot }`. Then code:

- drops an opening `¿` or `¡` and a final period when he almost never uses
  them (under 2 in 100 of his messages);
- runs the checks in section 6;
- on a failed check, asks the model once more with the reasons; if it fails
  again, nothing goes out, and the refused draft never goes back to the
  model.

When the owner gave no time, the voice asks for the time he usually books
with that person, as the chat shows it. Code checks that time against his
calendar and asks for another if he is busy. The slot it asked for is
stored: a contact who confirms that slot is inside the owner's scope, but
only when the day came from him. The errand records whether the day and
the time came from him (`slot_owned`, `time_owned`), so a card never says
"you asked for" a slot the draft picked.

## 5. Approvals: the built-in ones

Errands add no new kind of card. They use the approval service as it is.

- **Start.** `startErrand` is a tool call in the owner's chat and passes the
  gate under the `errand-send` rule, one of the outward rules. His request
  in his own chat, with nothing a third party wrote in the history, is his
  approval: it runs, and the first message goes out with no card. Otherwise
  it asks once. The first message to someone he has never written to also
  asks first. A request written in a run that read someone else's text is
  marked, and never shown back as his words. A draft (`send: false`) sends
  nothing, so it is not an outward action. A job, a watcher or a sub-agent
  that tries to start one is refused at the gate, with no card.
- **Who may start or answer one.** Only the owner, from his own chat or
  the web. The gate refuses `startErrand` and `answerErrand` from a job, a
  watcher, a sub-agent, a voice call or a contact's chat, with no card
  (`source_refused`): a card that looked like his own question would send a
  third party's words from his account. The errand's own run answers its
  own steps. `startErrand` and `answerErrand` count as "Message a contact"
  on his always-ask list.
- **A bare yes and other cards.** A bare yes decides any card only while
  the card is still the question he is answering: nothing came after it but
  the same run's reply, lines about cards, a question he answered, and his
  words that only answered a card or a question. After he asks for a draft,
  "dale, mandalo" is about the draft, never a job's card from the morning.
  A card that lands after the draft is the newest question, and a bare yes
  answers it. When his word reaches no card, the model hears which card
  waits and tells him to reply `/confirm <id>`; asking for the same step
  again raises no second card, and the model gets the id to give him.
- **His choices.** A slot other than the one he asked for (ask mode), a
  question from the contact, a refusal, an unclear answer or a voice note
  Deedee cannot read. Deedee asks with a card for `answerErrand`. It reads
  as a question in his language, without the tool name or the safety
  lines, and says why it asks: his calendar is busy then (or could not be
  read), the slot is outside his window or too soon, or the day or time was
  one the draft picked. "sí" runs it, "no" sends nothing, "cancelar"
  cancels the errand, and other words go to the model, which calls
  `answerErrand` with an explicit date and time. A bare yes decides an
  errand card only while the card is still the question he is answering
  (under any of his chat ids; see below). When the gate itself holds an errand step
  (someone else's words in his chat, or his always-ask list), its card is a
  plain question too: the exact text first, the person's People name, the
  date in his words and the true reason. It retires every older card for
  that errand, so a bare yes has one card to decide, and the errand follows
  it.
- **Steps inside his scope.** The contact confirms the slot he asked for,
  or, in window mode, offers a slot inside the window that is free on his
  calendar, and he has not decided otherwise since the slot was set
  (`auto_ok`: his "no" to a card, any step of his (even one that failed),
  a step of his on hold, a pause, or her "no tengo lugar" turn it off; a slot he proposed that goes out turns it
  on, and makes a window errand a slot errand). A card or note he has not
  answered yet leaves it on. The errand runs `answerErrand` through the same gate with an
  errand grant. The approval service asks the errand service to check the
  grant (errand open, step and slot inside the scope, limits not hit) and
  records the decision as `owner_grant`. The deny-list, the floor and his
  always-ask list still win.
- **The guardian** does not decide errand steps. A step is either inside
  the scope he set (it runs) or his choice (a card).

## 6. Security and limits

Code enforces these, not the prompt.

1. **Scope is fixed at the start:** one contact, one goal, a slot or a
   window, an end date. Only the owner changes it. The model never picks
   the recipient of an errand message: code takes it from the errand row.
   An errand never writes to the owner's own lines or to Deedee's number or
   WhatsApp ID: a message from his account to hers would arrive as his own
   word. When her number cannot be known (her session is down), no errand
   starts. The resolver's guess by the last digits counts only for the
   same line.
2. **The contact's text is data.** A voice note it cannot transcribe is
   named as such to the reader, and never lets a step go out on its own. A
   model with no tools reads it and fills
   a fixed JSON form (`offer`, `confirm`, `decline`, `question`, `answer`,
   `other`, with slots). Code checks the form: real dates, in the future,
   within the errand's life.
3. **Notes to the owner hold no text the contact wrote**, only facts code
   checked (a slot, the contact's name from People; a WhatsApp push name is
   the contact's own words, so a person not in People shows as a masked
   number). A note that says what the contact said (a question, an answer,
   news) carries the `jobTaint` mark, so his next word in that chat does not
   cover messages on its own.
4. **Every outgoing text passes checks:** at most 160 characters and 2
   lines; no link, email, phone number or `@`; no money, unless his own
   words mention it; no words aimed at a model ("ignorá", "instrucciones",
   "prompt", "Deedee", "IA" in capitals); no command to Deedee ("/confirm");
   an accepted or proposed slot must appear as its time; no brackets around
   words.
5. **Loops:** the errand stores what it sent and never reads its own sends
   as the contact's replies.
6. **The owner takes over:** before each send the errand reads the chat.
   If he wrote there himself since its last step (a reaction does not
   count), it steps aside and tells him.
7. **One step at a time:** every step on an errand runs under its lock, and
   it reads the row again before it sends or books. A message that lands
   while a step waits is read first; small talk lets the step go ahead. A
   closed errand is never written back to life. A slot that starts in less
   than 15 minutes is never accepted.
8. **Off switches:** `ERRANDS=0` (read on every call) turns starting, the
   message hook and the sweep off; a cancel still works. Each errand can be
   cancelled in chat or in the tab. `communication_dry_run` makes errands
   draft only.
9. **A log of every step** (`errand_events`): what came in (a short
   excerpt), the form, the decision, the text sent, the calendar result.

| Limit | Value |
|---|---|
| Open errands at once | 3; one per contact |
| Messages it sends on its own per errand | 4 (one message may be 2 short parts); then every step asks |
| All messages per errand | 10; then it pauses |
| Gap between its own messages | at least 1 minute |
| Quiet hours | 22:00-08:00 local: nothing goes out on its own and no note that can wait is sent; a step waits until 08:00, unless the slot would pass first (then he gets a card at once). A card or note about the contact's reply goes out at once: the slot may not wait |
| No answer from the contact | the owner hears after 4 hours; "me fijo" or small talk is no answer, so the wait counts from their last word; Deedee never writes again on her own |
| Life of an errand | until the slot's day, 7 days at most; a new day he proposes moves it. An end in quiet hours moves to 21:55, and past its end an errand closes at once, so it raises no cards at night |
| Voice notes | 60 seconds to transcribe, then unreadable |
| Model calls per errand | 20; then it pauses and tells him. His own steps, and the errand once he answers it after a pause, get 40 |
| Messages from the contact | 60 per errand; then it pauses |
| Message length | 160 characters, 2 lines |

Messages the owner decides (a card he approves, his own words through
`answerErrand`) go out at any hour and do not count toward the 4.

## 7. The calendar

Code, not the model, adds the event: the owner's primary calendar, no
guests, so no card is needed (`isOwnCalendarEvent`). The title comes from
`startErrand` (`eventTitle`, else "Turno - <name>"), with the location and
length the owner gave, and the description carries `(errand #N)`. Before
it adds one, it looks for the booking at that start: the same title, our
note, or his watcher's event naming the person in full (whole words). A
name inside another word ("Ana" in "semanal") never counts: an unrelated
event taken for the booking would hide a clash or leave the slot off his
calendar. The event id goes on the errand.

## 8. Tools

- `startErrand({ contact, goal, request, date?, time?, windowStart?, windowEnd?, eventTitle?, location?, durationMinutes?, send? })`
- `answerErrand({ id, action, date?, time?, text? })`, action one of
  `accept`, `propose`, `decline`, `say`, `cancel`; accept and propose need
  an explicit date and time
- `listErrands({ all? })`

`contact` must be a phone number, a WhatsApp ID or a People id, never a
name: the model finds it with `searchContacts` first. All three tools hold
only the owner's words and our own text: trusted
(`utils/untrusted-content.js`). A run that read untrusted content asks
before `startErrand` and `answerErrand`.

The errand rules and the open errands (id, person, goal, state, the slot
on the table, every slot offered) ride in the turn context of his own typed
chat only: jobs, watchers and voice calls never see them, and a voice call
does not get the three tools.

## 9. Data

- `errands`: id, contact (JIDs, name), goal, mode, request, slot, window,
  proposed slot, state, counters, event id, times, the pending card id.
- `errand_events`: errand id, time, kind, short detail.
- `agent_settings.owner_style_stats`: the numbers from section 4, refreshed
  once a day.

## 10. The tab

Autopilot → Errands: open and recent errands, each with its steps, and a
Cancel button. It updates live over the socket (`errands:update`).

## 11. Not in this version

Groups, email and Slack, moving or cancelling an existing booking (he
starts a new errand; the old event stays until he deletes it), several
people in one errand, reminders to the contact, phone calls, voice calls,
and starting or answering an errand from a job or a watcher. After the
12-hour watch, his watcher sees the chat again and may add an event of its
own.

## 12. Review

Fifteen review rounds (security, the owner's real flows replayed message by
message, regressions, and a check that each fix held) found real faults.
Each fix has a test named after the fault in
`apps/agent/tests/errands.test.js` ("review round one", "review round
two", "review round two, his flows", "review round three", "review round
four") and
`apps/agent/tests/errands-wiring.test.js`. Round three also changed the
approval service for every card: a bare yes no longer approves a card he
has moved on from (`docs/security.md`, Answers).
