# Specification: Wardrobe Service

## 1. Overview

A personal wardrobe assistant that catalogs clothing from photos, recommends outfit combinations, generates virtual try-on images (single or multi-panel mirror views), plans travel capsules with weather-aware packing lists, and maintains a shopping list for gaps discovered during outfit reasoning.

Delivered as a new service `WardrobeService` in `apps/agent`, a `/wardrobe` page in `apps/web`, and a set of tools the agent can call from any chat transport (Web, Telegram, WhatsApp).

Mirrors the architecture of the DJ/vinyl service ([specs/036-dj-assistant.md](036-dj-assistant.md)).

## 2. Design principles

1. **Trust the vision model.** Outputs must be at least as good as plain Gemini web. Do not pre-filter attributes with heuristics that reduce signal. Pass pixels to the model; reduce to text only when context pressure demands it.
2. **Non-blocking enrichment.** Ingestion returns immediately with placeholder records; background enrichment updates state via Socket.io. UI shows progressive reveal.
3. **Unified hybrid photo primitive.** When a user sends a photo of clothes, the service simultaneously matches to existing wardrobe records and auto-adds any unmatched items. The agent never asks the user "is this new or existing"; it just does both.
4. **Strict gating on brand identification only.** Attributes (type, color, pattern) store whatever the model returns and are cheap to edit in the UI. Brand/model inference requires two independent signals and a high confidence bar, otherwise is left null or surfaced as a user-confirm chip.
5. **Minimum viable state.** Track `times_worn` and `last_worn_at` only. No laundry state, no availability derivation.
6. **Weather via subagent.** No dedicated weather service. Fire a subagent with the existing weather skill ([apps/agent/skills/weather/SKILL.md](../apps/agent/skills/weather/SKILL.md)) when forecast data is needed.
7. **Live trip capsule.** A trip's packing list is user-editable after the trip starts; outfit reasoning during an active trip is scoped to the actual capsule, not the plan.

## 3. Data model

All tables use the `wr_` prefix (parallel to `dj_` for vinyl). Added to [apps/agent/src/db.js](../apps/agent/src/db.js).

### 3.1 `wr_garments`

```
id                       integer primary key
type                     text     -- top|bottom|shoes|outerwear|accessory|underwear|other
subtype                  text     -- tshirt|hoodie|chinos|sneakers|...
primary_color            text
secondary_colors         text     -- JSON array
pattern                  text     -- solid|striped|plaid|graphic|...
material_guess           text
warmth                   integer  -- 1..5
formality                integer  -- 1..5
season_tags              text     -- JSON array: spring|summer|fall|winter
brand                    text     -- nullable; only set if confidence gate passes
model                    text     -- nullable
size                     text
fit_notes                text
source_image_path        text     -- full original photo
crop_image_path          text     -- cropped single-item image
bbox                     text     -- JSON [x1,y1,x2,y2] normalized 0..1
source                   text     -- 'manual_upload'|'auto_from_chat'|'auto_from_trip'
enrichment_status        text     -- 'enriching'|'complete'|'failed'|'needs_brand_confirm'
enrichment_confidence    real
meta                     text     -- JSON: {visionRaw, searchHits, distinguishingFeatures}
times_worn               integer default 0
last_worn_at             text     -- ISO timestamp, nullable
created_at               text
```

### 3.2 `wr_outfits`

```
id                       integer primary key
name                     text     -- auto-generated or user-edited
occasion                 text
weather_tags             text     -- JSON
garment_ids              text     -- JSON array of wr_garments.id
rendered_image_path      text     -- nullable; set after visualize_outfit
liked                    integer default 0
last_suggested_at        text
created_at               text
```

### 3.3 `wr_trips`

```
id                       integer primary key
calendar_event_id        text     -- nullable
destination              text
start_date               text
end_date                 text
activities               text     -- JSON array
weather_snapshot         text     -- JSON from weather subagent
planned_capsule          text     -- JSON array of garment_ids
actual_capsule           text     -- JSON array of garment_ids (editable during trip)
status                   text     -- 'planned'|'active'|'completed'
created_at               text
```

### 3.4 `wr_shopping_list`

```
id                       integer primary key
description              text     -- "army green crew-neck tee"
type                     text
primary_color            text
pattern                  text
material_hint            text
suggested_context        text     -- JSON: {outfit_id, reason}
priority                 text     -- 'low'|'medium'|'high'
status                   text     -- 'wanted'|'purchased'|'dismissed'
resolved_garment_id      integer  -- nullable; set when mark_purchased links to new wr_garments row
added_at                 text
purchased_at             text
```

### 3.5 `wr_user_profile` (singleton, id=1)

```
id                       integer primary key  -- always 1
reference_image_path     text     -- full-body selfie for virtual mirror
preferred_brands         text     -- JSON; seeded ["Lacoste","Lululemon"]
sizing                   text     -- JSON per-category
style_notes              text
updated_at               text
```

## 4. Shared infrastructure

### 4.1 Image storage

Filesystem layout under `${DATA_DIR}/wardrobe/`:

```
wardrobe/
  garments/{garment_id}/original.jpg
  garments/{garment_id}/crop.jpg
  outfits/{outfit_id}/render.jpg
  profile/reference.jpg
```

Served via new Next.js route `apps/web/src/app/wardrobe_images/[...path]/route.js` (same pattern as vinyl_covers).

### 4.2 Model selection

Reuse `configService.getModel(key)` keys:
- `VISION_FAST` (Gemini Flash) — detection, attribute extraction, one-shot matching
- `REASONING` (Gemini Pro) — outfit recommendation, critique, packing reasoning
- `IMAGE` (existing `gemini-3-pro-image-preview`) — virtual mirror

### 4.3 Socket.io events

Namespaced `wardrobe:*`:
- `wardrobe:garment:detected` — card should appear with crop + placeholder tags
- `wardrobe:garment:attributes` — tags filled in
- `wardrobe:garment:enriched` — enrichment_status final
- `wardrobe:garment:update` — generic update
- `wardrobe:garment:delete`
- `wardrobe:outfit:rendered` — render ready
- `wardrobe:trip:update`
- `wardrobe:shopping:update`

### 4.4 Weather pattern

Any code path that needs a forecast calls:

```js
const result = await agent.subAgentService.spawn({
  task: `Get daily forecast for ${location} from ${startDate} to ${endDate}.
Return JSON array, one entry per day: {date, tempMin, tempMax, condition, precipitationMm}.`,
  tools: ['runShellCommand'],
  waitForResult: true,
  lightweight: true,
});
```

Subagent uses [skills/weather/SKILL.md](../apps/agent/skills/weather/SKILL.md) (wttr.in primary, Open-Meteo fallback).

### 4.5 Cross-transport photo ingestion

Agent webhook at [apps/agent/src/server.js](../apps/agent/src/server.js) already accepts a generic `{parts: [{inlineData: {mimeType, data}}]}` contract. Both [apps/interfaces/src/whatsapp.js](../apps/interfaces/src/whatsapp.js) and the web upload flow already produce this. [apps/interfaces/src/telegram.js](../apps/interfaces/src/telegram.js) currently handles only `text` and `voice`; a `photo` listener must be added (P4).

## 5. Tool surface

Registered in [apps/agent/src/tools-definition.js](../apps/agent/src/tools-definition.js), handled by `WardrobeExecutor` at `apps/agent/src/executors/wardrobe.js`.

```
# Cataloging
analyze_outfit_photo(image_base64, caption?)
add_garment(image_base64)
list_garments(filters?)
get_garment(id)
search_garments(query)
update_garment(id, patch)
delete_garment(id)
confirm_brand(garment_id, accept)

# Outfits
recommend_outfit(garment_ids?, trip_id?, context?, count?)
visualize_outfit(garment_ids_panels, layout?)
critique_outfit(image_or_garment_ids, question?)
like_outfit(outfit_id)
list_outfits(filters?)
log_wear(outfit_id_or_garment_ids, date?)

# Trips
pack_for_trip(destination, start_date, end_date, activities?, calendar_event_id?)
get_trip(id)
list_trips(status?)
start_trip(id)
complete_trip(id)
set_trip_capsule(id, garment_ids)
add_to_trip_capsule(id, image_or_ids)
remove_from_trip_capsule(id, ids)

# Shopping
add_to_shopping_list(description, context?, priority?)
list_shopping_items(status?)
mark_purchased(id, garment_id?)
dismiss_shopping_item(id)

# Profile
set_reference_selfie(image_base64)
get_user_profile()
set_preferred_brands(brands)
```

## 6. Phase-by-phase plan

Each phase is a mergeable unit. Phase order optimized to deliver usable chat flow as early as possible.

---

### P1 — Foundation

**Goal**: service skeleton, DB tables, single-item manual upload, basic `/wardrobe` grid, Socket.io wiring.

**Depends on**: nothing.

**DB**: create all five tables from §3. Seed `wr_user_profile` with `id=1`, `preferred_brands=["Lacoste","Lululemon"]`.

**Files created**:
- `apps/agent/src/services/wardrobe-service.js` — `WardrobeService` class with constructor, `ingestGarmentFromBase64()`, CRUD wrappers around `db.*Garment` methods, stub `_detectItems()` returning single-item passthrough
- `apps/agent/src/routes/wardrobe.js` — Express router mounted at `/api/wardrobe`. Routes: `POST /garments/upload`, `GET /garments`, `GET /garments/:id`, `PUT /garments/:id`, `DELETE /garments/:id`, `GET /profile`, `PUT /profile`
- `apps/agent/src/executors/wardrobe.js` — `WardrobeExecutor` extending `BaseExecutor` with `add_garment`, `list_garments`, `get_garment`, `update_garment`, `delete_garment`, `search_garments`
- `apps/web/src/app/wardrobe/page.js` — client component with grid view, upload drop-zone, mobile-first 2-col layout, filter chips (type/color/season), Socket.io subscription
- `apps/web/src/app/wardrobe_images/[...path]/route.js` — image serve route
- `apps/agent/tests/wardrobe.test.js` — ingest + CRUD tests

**Files modified**:
- `apps/agent/src/db.js` — add table creation, `addGarment()`, `getGarment()`, `getGarments()`, `updateGarment()`, `deleteGarment()`, `searchGarments()`, `getUserProfile()`, `updateUserProfile()`
- `apps/agent/src/agent.js` — instantiate `WardrobeService`, register executor in `toolExecutor.services.wardrobe`
- `apps/agent/src/server.js` — mount wardrobe router
- `apps/agent/src/tools-definition.js` — add 6 tool schemas from P1 set

**UI**:
- Mobile-first: 2-col grid default, 4-5 on desktop. Tap-target ≥ 44px. Bottom-sheet modal for detail.
- Upload button uses `<input type="file" accept="image/*" capture="environment">` — opens native camera on mobile.
- Grid cards show crop, type, primary_color as chip. Loading skeleton shimmer.

**Socket.io events**: `wardrobe:garment:update`, `wardrobe:garment:delete`.

**Acceptance**:
- Upload a photo via web → garment row created → appears in grid
- Edit a field via detail modal → update propagates via Socket.io
- Delete removes the row and its image files
- API test coverage on CRUD

---

### P2 — Multi-item detection and auto-tag

**Goal**: one photo can contain multiple garments; each is detected, cropped, tagged, saved. No confirm step — user edits inline after the fact.

**Depends on**: P1.

**Files modified**:
- `wardrobe-service.js`:
  - `ingestGarmentFromBase64(base64, opts)` → calls `_detectItems(base64)`, then for each detection saves the original once, crops via `sharp`, saves crop, inserts row with `enrichment_status='enriching'`, emits `wardrobe:garment:detected`
  - `_detectItems(base64)` → single Gemini Flash call returning JSON items with bbox + attributes (see Appendix A.1)
  - `_cropToFile(sourcePath, bbox, outPath)` → `sharp`-based crop
  - `_runAttributePass(garmentId)` → background, re-extracts attrs from the crop specifically (cleaner signal than detection pass), updates row, emits `wardrobe:garment:attributes`
- `apps/web/src/app/wardrobe/page.js`:
  - Progress bar during multi-item upload: `3/7 analyzed`
  - Skeleton chip shimmer until `wardrobe:garment:attributes` arrives
  - Inline-editable chips for each attribute (tap to edit)

**Dependencies**: `sharp` (likely already present — check [package.json](../apps/agent/package.json)).

**Acceptance**:
- Photo with 3 items produces 3 rows, each with its own crop
- Bbox stored normalized so re-cropping is idempotent
- Attributes land within ~5s via Socket.io, no page reload
- Manual inline edit of a chip persists and broadcasts

---

### P3 — Strict brand enrichment

**Goal**: identify brand/model only when confident. Surface as a user-confirm chip if below threshold.

**Depends on**: P2.

**Files modified**:
- `wardrobe-service.js`:
  - `_enrichBrand(garmentId)` → grounded-search Gemini call. Prompt includes the crop, `distinguishing_features` from detection meta, and bias note: *"the user prefers Lacoste and Lululemon; prioritize these if a logo or signature mark matches, but do not invent"*
  - Auto-accept only when: (confidence ≥ 0.95) AND (search result cites a verbatim visual identifier — logo text, signature mark, or named model in the wardrobe crop)
  - Otherwise set `enrichment_status='needs_brand_confirm'` and stash candidate in `meta.brandCandidate`
  - Final success → `enrichment_status='complete'`, emit `wardrobe:garment:enriched`
- `executors/wardrobe.js`: add `confirm_brand(garment_id, accept: bool)` tool
- Web UI: if status is `needs_brand_confirm`, render a "Lacoste? confirm / reject" chip on the card

**Acceptance**:
- Generic unbranded tee → brand stays null, status `complete`
- Clear Lacoste crocodile → auto-accepts, brand set
- Ambiguous logo → `needs_brand_confirm`, UI chip, user tap persists decision
- Never auto-populates brand without explicit visual citation

---

### P4 — Cross-transport photo ingestion

**Goal**: photos arrive identically via Web, Telegram, WhatsApp.

**Depends on**: P1 (for web), independent of P2/P3 otherwise.

**Files modified**:
- `apps/interfaces/src/telegram.js`:
  - Add `this.bot.on('photo', this.handlePhoto.bind(this))` alongside text and voice handlers
  - `handlePhoto(ctx)`: pick largest photo size, fetch via Telegraf, convert to base64, build message via `createUserMessage(caption, 'telegram', userId)` with `parts: [{inlineData: {mimeType:'image/jpeg', data: base64}}]`, POST to `/webhook`
- `apps/interfaces/src/whatsapp.js`: audit image-message handling; ensure same shape is produced. Add if missing.
- `apps/agent/src/server.js`: no change (contract already accepts parts)

**Acceptance**:
- Photo + caption "add these" from Telegram → agent receives a message with parts → agent can invoke `add_garment`
- Same from WhatsApp
- Tested by sending a photo via each transport and checking garment rows appear

---

### P5 — `analyze_outfit_photo` unified primitive

**Goal**: single tool for the "photo of clothes → what to wear" flow. Simultaneously matches existing wardrobe items and auto-adds unmatched ones.

**Depends on**: P2, P3.

**Files modified**:
- `wardrobe-service.js`:
  - `analyzeOutfitPhoto(base64, opts)`:
    1. `_detectItems(base64)` → N detections
    2. Build a candidate shortlist from wardrobe. If `wr_garments` ≤ 80, send all. Otherwise shortlist by recency, by matching top-level type, and items from the current trip's `actual_capsule` if there is an active trip. Cap at ~80 crops.
    3. Single Gemini Pro call: input = user's photo + shortlist crops labeled by id. Prompt: *"For each distinguishable garment in the main photo, return either the matching id from the provided wardrobe items, or NEW if it is not present."* Structured JSON output (see Appendix A.2).
    4. For each detection:
       - If matched id → record match, update `last_worn_at` is **not** set here (only on explicit `log_wear`)
       - If NEW → run ingestion pipeline (`_cropToFile` + insert + enqueue `_runAttributePass` + `_enrichBrand`) with `source='auto_from_chat'`. Emit `wardrobe:garment:detected`.
       - Auto-check shopping list: if attributes of new item match an open `wr_shopping_list` item ≥ 0.8 similarity, annotate return payload with `shopping_list_hit: {id, description}` so the agent can ask user about marking purchased (P11).
    5. Return: `{matched: [garment_id], newly_added: [garment_id], notes}`
- `executors/wardrobe.js`: add `analyze_outfit_photo`
- `tools-definition.js`: add schema with description clarifying agent should call this before `recommend_outfit` when an image is part of the user's current request

**Acceptance**:
- Photo of 2 known items + 1 new item → 2 matched ids, 1 newly_added id
- Recommendation tool can be called with the full set immediately, without waiting for enrichment
- Active-trip mode (P10b) shortlists from capsule first
- Shopping-list crossref surfaces in return payload when applicable

---

### P6 — `recommend_outfit`

**Goal**: agent generates outfit suggestions from the wardrobe or from a supplied subset, given free-text context.

**Depends on**: P1. Works better after P5 for photo-driven queries.

**Files modified**:
- `wardrobe-service.js`:
  - `recommendOutfit({garmentIds?, tripId?, context, count=4})`:
    1. Resolve candidate pool:
       - If `garmentIds` → just those
       - Else if `tripId` on active trip → `actual_capsule`
       - Else → full wardrobe
    2. Build input: for pools ≤ 30 items, include crops inline. Larger → text summary of each garment (id, type, subtype, color, warmth, formality, season).
    3. Fetch liked outfits (`wr_outfits.liked=1`) for bias: include 3-5 as examples of user-approved combos.
    4. Gemini Pro call with 4-bucket prompt (Appendix A.3): returns one proposal per bucket — `weather_anchored`, `occasion_anchored`, `item_anchored` (if user referenced a specific piece), `safe_repeat` (variation on a liked outfit). Each bucket: garment_ids + rationale.
    5. Save each proposal to `wr_outfits` with `liked=0`, return outfit ids.
- `executors/wardrobe.js`: add `recommend_outfit` + `like_outfit` + `list_outfits`
- Web UI: outfit carousel component on `/wardrobe` — horizontal scroll with snap, each card shows 4 garment thumbs + rationale + heart icon

**Acceptance**:
- Given context "dinner, 18C, casual" → 4 distinct proposals across buckets
- Liked outfits influence future recommendations (regression check with fixtures)
- Works both with and without an image context
- Rationale is specific to the chosen items, not generic

---

### P7 — Virtual mirror (single-panel)

**Goal**: render a photorealistic mirror image of the user wearing a chosen combo.

**Depends on**: P6 (to have something to render). Uses existing image-generation plumbing in [apps/agent/src/executors/media.js](../apps/agent/src/executors/media.js).

**Files modified**:
- `wardrobe-service.js`:
  - `visualizeOutfit({garmentIdsPanels, layout})` — accepts one panel (array of ids) for P7
  - First call ever without a reference selfie → return `{needs_reference: true}`; executor surfaces a prompt asking user to upload one
  - Builds prompt per Appendix A.4, calls `IMAGE` model with reference + garment crops inline
  - Saves output to `wardrobe/outfits/{outfit_id}/render.jpg`, updates `wr_outfits.rendered_image_path`, emits `wardrobe:outfit:rendered`
  - `setReferenceSelfie(base64)` stores in `wr_user_profile.reference_image_path`
- `executors/wardrobe.js`: add `visualize_outfit`, `set_reference_selfie`, `get_user_profile`
- Web UI:
  - `/wardrobe/settings` page with selfie upload and brand preferences
  - If missing on first `visualize_outfit`, redirect to settings
  - Outfit card gets "Preview" button that triggers render and shows result inline with "regenerate" option
- Factor out `generateImageFromParts(parts, prompt)` in [media.js](../apps/agent/src/executors/media.js) so wardrobe reuses it without duplication

**Acceptance**:
- With reference stored, `visualize_outfit([t1, p1, s1])` produces a mirror image within ~10-20s
- Face and body proportions are recognizably the user
- Missing reference triggers onboarding flow end-to-end
- Failure path surfaces a user-friendly error, not a silent hang

---

### P8 — Multi-mirror render

**Goal**: render N outfit variations as panels in a single image — matches the user's reference screenshot (4 panels labeled 1..4).

**Depends on**: P7.

**Files modified**:
- `wardrobe-service.js.visualizeOutfit` extended:
  - `garmentIdsPanels: [[ids...], [ids...], ...]` — 1 to 4 panels
  - `layout`: auto | horizontal | grid. Auto picks based on N: 1→single, 2→horizontal, 3→horizontal, 4→2x2
  - Prompt variant in Appendix A.5 — instructs generation of N mirror panels side-by-side with numeric labels, consistent lighting, same setting
- Web UI: "Preview all" button on outfit carousel renders the 4 current proposals as one multi-mirror image

**Acceptance**:
- 4 outfit proposals → one wide image with 4 labeled panels, consistent background/face
- Falls back cleanly to single-panel if N=1

---

### P9 — Critique

**Goal**: user sends a photo (or selects garments) with a question like "does this work?" — agent scores the combo, highlights strengths and weaknesses, proposes a better alternative from the full wardrobe.

**Depends on**: P5, P6.

**Files modified**:
- `wardrobe-service.js`:
  - `critiqueOutfit({imageBase64?, garmentIds?, question?})`:
    1. If image → run `analyzeOutfitPhoto` first to get ids (and auto-add any new items)
    2. Gemini Pro call with: combo crops + wardrobe candidate pool + question text. Prompt in Appendix A.6. Returns structured `{score 0-10, strengths[], weaknesses[], better_alternative: {garment_ids, rationale}}`
    3. Save critique as a lightweight log row (optional: add `wr_critiques` table later if we want history; P9 MVP does not persist)
- `executors/wardrobe.js`: add `critique_outfit`
- Optional: agent may chain `visualize_outfit` on the `better_alternative` if user asks to see it

**Acceptance**:
- Photo + "does this work?" → score + 2-3 bullets each of strengths/weaknesses + concrete alternative garment_ids that exist in wardrobe
- Alternative never proposes nonexistent items
- Critique is grounded in the actual combo (cites specific pieces), not generic

---

### P10a — `pack_for_trip`

**Goal**: given a destination and dates, produce a packing list optimized as a capsule (minimum items, maximum combinations).

**Depends on**: P6 (outfit reasoning).

**Files modified**:
- `wardrobe-service.js`:
  - `packForTrip({destination, startDate, endDate, activities, calendarEventId})`:
    1. Spawn weather subagent (§4.4), receive daily forecast
    2. Build wardrobe summary (exclude items with `source='auto_from_trip'` from prior trips — they may no longer be in user's closet)
    3. Gemini Pro call with weather + activities + wardrobe → returns capsule as garment_ids and a per-day suggested outfit list (ids per day)
    4. Insert `wr_trips` row with `planned_capsule`, `weather_snapshot`, `status='planned'`
    5. Emit `wardrobe:trip:update`
- `executors/wardrobe.js`: add `pack_for_trip`, `get_trip`, `list_trips`
- Web UI: `/wardrobe/trip/[id]` page — capsule view with crops, per-day outfit plan, weather strip

**Acceptance**:
- 5-day Porto trip in spring → realistic capsule (≤ 8 tops, ≤ 4 bottoms, 1-2 shoe pairs, layering)
- Weather matches forecast from wttr.in for the given dates/city
- Capsule covers each planned day with an outfit from within the capsule (no external items)

---

### P10b — Live trip capsule

**Goal**: once a trip starts, user can manually set or modify what they actually brought. Recommendations during the trip use only the actual capsule.

**Depends on**: P10a, P5.

**Files modified**:
- `wardrobe-service.js`:
  - `startTrip(id)` → `status='active'`. If `actual_capsule` is null, copy `planned_capsule` into it.
  - `setTripCapsule(id, garmentIds)` → overwrites `actual_capsule`
  - `addToTripCapsule(id, imageOrIds)` → if image, run `analyzeOutfitPhoto` (§P5) but **scoped-match-first**: try matching against wardrobe, auto-add any new items, then append all resulting ids to `actual_capsule`
  - `removeFromTripCapsule(id, ids)` → remove
  - `completeTrip(id)` → `status='completed'`
  - `recommendOutfit()` uses active trip's `actual_capsule` when `tripId` is supplied
- Web UI `/wardrobe/trip/[id]`:
  - Edit mode for capsule: drag in/out from full wardrobe, or tap "Add from photo" to drop in an image of what's on the hotel bed
  - Active-trip banner on main `/wardrobe` page with quick link

**Acceptance**:
- User starts trip, removes 2 items, adds 1 new one via photo → capsule reflects all three changes
- `recommend_outfit(trip_id=X)` never proposes an id outside `actual_capsule`
- New items added via photo land in `wr_garments` too (not just in capsule JSON), so they persist beyond trip

---

### P11 — Shopping list

**Goal**: missing-piece capture during outfit reasoning, with cross-reference when a new garment is ingested.

**Depends on**: P5, P6.

**Files modified**:
- `wardrobe-service.js`:
  - `addToShoppingList({description, type, primary_color, pattern, material_hint, context, priority='medium'})` — simple insert
  - `listShoppingItems({status})` — read
  - `markPurchased(id, garmentId?)` — set status, link resolved_garment_id if provided, timestamp
  - `dismissShoppingItem(id)` — set status
  - Hook in `_runAttributePass` (P2): after attributes land for a newly ingested garment, compare attrs against open shopping items. If close match (type + primary_color + optional pattern/material), attach candidate id to `meta.shoppingMatch` and emit an event so UI can prompt
- `recommendOutfit` prompt update (Appendix A.3): if proposer identifies a missing piece that would complete a strong outfit, returns it in a `wants` field. Service auto-inserts to `wr_shopping_list` and returns ids in recommendation payload.
- `executors/wardrobe.js`: add `add_to_shopping_list`, `list_shopping_items`, `mark_purchased`, `dismiss_shopping_item`
- Web UI: `/wardrobe/shopping` tab — list view, priority sort, mobile-first cards. Each card: description, attributes, context ("for outfit #42"), buttons (mark purchased, dismiss)

**Acceptance**:
- Recommendation mentioning "an army green crew-neck would complete this" creates a shopping row
- Subsequent ingestion of an army green crew-neck tee surfaces a prompt "this looks like the crew-neck you were looking for — mark purchased?"
- Tap yes → shopping row status='purchased', resolved_garment_id set

---

### P12 — Calendar-driven proactivity

**Goal**: pre-trip packing DM, morning outfit nudge.

**Depends on**: P10a, P7 (for optional render in the nudge).

**Files modified**:
- `apps/agent/src/scheduler.js` (or equivalent jobs loader):
  - `wardrobe_pretrip_check` — daily at 08:00. Reads upcoming calendar events via existing calendar tools, looks for events labeled as trips or with a destination in the title/location. For trips starting in N days (N=3 default), if no `wr_trips` row exists yet, draft one via `packForTrip` and DM: *"Trip to Porto in 3 days — here's a suggested capsule. Review?"*
  - `wardrobe_morning_outfit` — daily at 07:15, opt-in via user profile flag. Reads today's calendar + weather for user's home city, calls `recommendOutfit` with `count=2`, DMs top result with a render.
- Profile flag `morning_outfit_enabled` added to `wr_user_profile`

**Acceptance**:
- Calendar event "Porto trip" with location Portugal, dates in 3 days → packing DM arrives
- Morning nudge fires only when enabled, produces a recommendation + optional render
- Silent output when nothing meaningful to say (following `[SILENT]` convention from [specs/043-proactive-agent.md](043-proactive-agent.md))

---

### P13 — Gap analysis ("should I buy this?")

**Goal**: while shopping IRL, user photographs a candidate item and asks. Agent virtually inserts it into wardrobe, regenerates outfits, and reports marginal utility.

**Depends on**: P6, optionally P7.

**Files modified**:
- `wardrobe-service.js`:
  - `gapAnalysis({imageBase64, priceHint?, context?})`:
    1. Run detection on the candidate image (do not insert)
    2. Build a hypothetical wardrobe = real wardrobe + hypothetical item with a temp id
    3. Call `recommendOutfit` twice: once excluding, once including. Diff outfit space.
    4. Find closest real-wardrobe neighbor by attributes (redundancy check)
    5. Project cost-per-wear from similar existing items' `times_worn` (requires P12 running for a while to have signal; for P13 MVP estimate only if signal exists)
    6. Return structured `{marginal_new_outfits, redundant_with: garment_id, estimated_cpw_cents?, recommendation: 'buy'|'skip'|'maybe'}`
- `executors/wardrobe.js`: add `gap_analysis`

**Acceptance**:
- Photo of a navy tee when user owns 3 navy tees → recommendation `skip`, cites redundant item
- Photo of an unusual pattern/color → recommendation `buy` with specific outfit count delta

---

## 7. Testing strategy

- **Unit**: Jest tests per service method, mock Gemini client and filesystem. Pattern follows [apps/agent/tests/dj.test.js](../apps/agent/tests/dj.test.js).
- **Fixtures**: a small set of sample garment photos committed under `apps/agent/tests/fixtures/wardrobe/` — single-item, multi-item, branded, unbranded. Used for deterministic detection path (mocked LLM responses) and for manual smoke tests.
- **Integration**: live-model sanity tests gated behind `RUN_LIVE=1` env flag, not in CI.
- **Regression for recommender bias**: after inserting 3 liked outfits of a certain pattern, `recommend_outfit` should surface a variation in the `safe_repeat` bucket on ≥ 8/10 runs.

## 8. Rollout / MVP line

**MVP = P1, P2, P3, P4, P5, P6, P11.**

Delivers: web + Telegram + WhatsApp photo ingestion; multi-item detection with strict brand gating; hybrid "chat photo → outfit suggestion" flow with auto-add of unmatched items; outfit recommendations with 4 buckets; shopping list with ingest crossref.

**Post-MVP stack**: P7 (virtual mirror), P8 (multi-mirror), P9 (critique), P10a+P10b (trips), P12 (proactive), P13 (gap analysis).

## 9. Open items

- Whether to persist critiques (`wr_critiques` table) — deferred to post-P9 once usage is observed.
- Embedding-based garment similarity (CLIP or Gemini embeddings) — potential replacement for the Gemini Pro "single-shot matcher" when wardrobe grows beyond ~80 items. Revisit after MVP.
- Multi-user — out of scope; `wr_user_profile` singleton assumes single owner.
- Authentication on `/wardrobe` web routes — follow whatever [apps/web/src/app/dj/page.js](../apps/web/src/app/dj/page.js) uses (same scope per user answer).

## 10. Appendix A — key prompts

### A.1 Multi-item detection (Gemini Flash)

```
Identify every distinguishable garment or accessory in this photo. Return strict JSON:
{
  "items": [
    {
      "bbox": [x1, y1, x2, y2],           // normalized 0..1
      "type": "top|bottom|shoes|outerwear|accessory|underwear|other",
      "subtype": "tshirt|polo|hoodie|chinos|jeans|sneakers|...",
      "primary_color": "...",
      "secondary_colors": ["..."],
      "pattern": "solid|striped|plaid|graphic|...",
      "material_guess": "...",
      "warmth": 1-5,
      "formality": 1-5,
      "season_tags": ["spring","summer","fall","winter"],
      "distinguishing_features": "free text — logos, stitching, named model, distinctive cut",
      "detection_confidence": 0..1
    }
  ],
  "scene_notes": "overall framing notes"
}
Only include items that are clearly visible and identifiable. If uncertain about an attribute, omit that field. Do not fabricate brands.
```

### A.2 Hybrid match (Gemini Pro)

```
You will see one primary photo and a grid of numbered wardrobe items.
For each distinct garment in the primary photo, output either:
  {detection_bbox, match: "id_<n>"}
if the item in the photo is clearly the same physical piece as wardrobe item <n>, OR
  {detection_bbox, match: "NEW", attributes: {...same schema as A.1...}}
if it is not present in the wardrobe.
Be strict: only match when confident it is the same item (same pattern, same logo placement, same color shade). Otherwise mark NEW.
Return strict JSON with a top-level "detections" array.
```

### A.3 Outfit recommendation (Gemini Pro)

```
Context: {weather, occasion, location, dress_code, free_text}
Available garments: {list with ids and key attributes, crops inline where pool ≤ 30}
Previously liked outfits: {3-5 examples as garment_id sets + rationale if available}
User brand preferences: {preferred_brands}

Produce up to 4 outfit proposals, one per bucket:
  1. weather_anchored — optimized for forecast
  2. occasion_anchored — optimized for context's occasion
  3. item_anchored — if context mentions a specific item, build around it (else omit)
  4. safe_repeat — a variation on a liked outfit

Each proposal returns:
  {bucket, garment_ids: [], rationale: 1-2 sentences, wants?: [{description, type, color}]}
Only populate "wants" when a missing piece would meaningfully improve the combo. Do not invent items.
Output strict JSON: {proposals: [...]}
```

### A.4 Virtual mirror single-panel (IMAGE model)

```
Generate a realistic mirror photo of the person shown in the reference image, wearing exactly the clothing items pictured in the additional reference crops.
- Full-body, standing, natural pose, mirror selfie framing
- Clean neutral setting, soft natural lighting
- Preserve the person's face, build, and proportions faithfully
- Garments must match color, pattern, fit, and visible detailing of the crops
- No text overlays, no watermarks
```

### A.5 Multi-mirror (IMAGE model)

```
Generate a single wide photo showing {N} mirror panels side-by-side.
Each panel shows the reference person wearing a different outfit:
  Panel 1: {outfit 1 crops}
  Panel 2: {outfit 2 crops}
  ...
- Consistent lighting, background, and pose across panels
- Label the bottom of each panel with its number (1, 2, 3, ...)
- Preserve face, build, proportions
- Panels separated by thin gaps, uniform framing
```

### A.6 Critique (Gemini Pro)

```
Evaluate the outfit shown (by crops or by the garment list provided), considering {question if any}.
Return strict JSON:
{
  "score": 0-10,
  "strengths": [1-3 specific bullets citing the pieces],
  "weaknesses": [1-3 specific bullets citing the pieces],
  "better_alternative": {
    "garment_ids": [ids from the provided wardrobe pool only],
    "rationale": "1-2 sentences"
  }
}
Do not propose items outside the provided wardrobe pool. Be specific and substantive; avoid generic fashion advice.
```
