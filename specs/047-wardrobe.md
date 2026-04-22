# Specification: Wardrobe Service

> **Status**: implemented (P1–P12). Feature documentation at [docs/wardrobe.md](../docs/wardrobe.md).

## 1. Overview

A personal wardrobe assistant that catalogs clothing from photos, recommends outfit combinations, generates virtual try-on images (single or multi-panel mirror views), plans travel capsules with weather-aware packing lists, and maintains a shopping list for gaps discovered during outfit reasoning.

Delivered as a new service `WardrobeService` in `apps/agent`, a `/wardrobe` page in `apps/web`, and a set of tools the agent can call from any chat transport (Web, Telegram, WhatsApp).

Mirrors the architecture of the DJ/vinyl service (see [specs/036-dj-assistant.md](036-dj-assistant.md)).

## 2. Design principles

1. **Trust the vision model.** Outputs must be at least as good as plain Gemini web. Do not pre-filter attributes with heuristics that reduce signal. Pass pixels to the model; reduce to text only when context pressure demands it.
2. **Non-blocking enrichment.** Ingestion returns immediately with placeholder records; background enrichment updates state via Socket.io. UI shows progressive reveal.
3. **Unified hybrid photo primitive.** When a user sends a photo of clothes, the service simultaneously matches to existing wardrobe records and auto-adds any unmatched items. The agent never asks the user "is this new or existing"; it just does both.
4. **Strict gating on brand identification only.** Attributes (type, color, pattern) store whatever the model returns and are cheap to edit in the UI. Brand/model inference requires two independent signals and a high confidence bar, otherwise is left null or surfaced as a user-confirm chip.
5. **Minimum viable state.** Track `times_worn` and `last_worn_at` only. No laundry state, no availability derivation.
6. **Weather via subagent.** No dedicated weather service. Fire a subagent with the existing weather skill ([apps/agent/skills/weather/SKILL.md](../apps/agent/skills/weather/SKILL.md)) when forecast data is needed.
7. **Live trip capsule.** A trip's packing list is user-editable after the trip starts; outfit reasoning during an active trip is scoped to the actual capsule, not the plan.
8. **No hardcoded model ids.** Every Gemini call uses `configService.getModel('FLASH'|'PRO'|'IMAGE')`, which resolves from env (`WORKER_FLASH`, `WORKER_PRO`, `GEMINI_IMAGE_MODEL`).
9. **Public surface is auth-gated, agent surface is Docker-internal.** `/v1/wardrobe/*` sits behind `authMiddleware` alongside `/v1/dj`; `/internal/wardrobe/*` is only reachable inside the Docker network.

## 3. Data model

All tables use the `wr_` prefix (parallel to `dj_` for vinyl). Added to [apps/agent/src/db.js](../apps/agent/src/db.js).

### 3.1 `wr_garments`

```
id                       TEXT primary key (UUID)
type                     TEXT     -- top|bottom|shoes|outerwear|accessory|underwear|other
subtype                  TEXT
primary_color            TEXT
secondary_colors         TEXT     -- JSON array
pattern                  TEXT
material_guess           TEXT
warmth                   INTEGER  -- 1..5
formality                INTEGER  -- 1..5
season_tags              TEXT     -- JSON array
brand                    TEXT     -- nullable; only set if confidence gate passes
model                    TEXT
size                     TEXT
fit_notes                TEXT
source_image_path        TEXT     -- absolute path to original upload
crop_image_path          TEXT     -- absolute path to per-item crop (equals source for full-frame)
bbox                     TEXT     -- JSON [x1,y1,x2,y2] normalized 0..1
source                   TEXT     -- 'manual_upload'|'auto_from_chat'|'auto_from_trip'
enrichment_status        TEXT     -- 'enriching'|'complete'|'failed'|'needs_brand_confirm'
enrichment_confidence    REAL
meta                     TEXT     -- JSON (see Meta Schema in docs/wardrobe.md)
times_worn               INTEGER default 0
last_worn_at             TEXT
created_at               DATETIME default CURRENT_TIMESTAMP
```

### 3.2 `wr_outfits`

```
id                       TEXT primary key
name                     TEXT     -- auto-generated or user-edited
occasion                 TEXT
weather_tags             TEXT     -- JSON
garment_ids              TEXT     -- JSON array
rendered_image_path      TEXT     -- nullable; set after visualize_outfit
liked                    INTEGER default 0
last_suggested_at        TEXT
created_at               DATETIME
```

### 3.3 `wr_trips`

```
id                       TEXT primary key
calendar_event_id        TEXT     -- nullable
destination              TEXT
start_date               TEXT     -- YYYY-MM-DD
end_date                 TEXT     -- YYYY-MM-DD
activities               TEXT     -- JSON array
weather_snapshot         TEXT     -- JSON {days, daily_plan, pack_rationale}
planned_capsule          TEXT     -- JSON array of garment_ids
actual_capsule           TEXT     -- JSON array; editable during active trip
status                   TEXT     -- 'planned'|'active'|'completed'
created_at               DATETIME
```

### 3.4 `wr_shopping_list`

```
id                       TEXT primary key
description              TEXT not null
type                     TEXT
primary_color            TEXT
pattern                  TEXT
material_hint            TEXT
suggested_context        TEXT     -- JSON: {outfit_id, reason}
priority                 TEXT     -- 'low'|'medium'|'high'
status                   TEXT     -- 'wanted'|'purchased'|'dismissed'
resolved_garment_id      TEXT     -- set when mark_wardrobe_item_purchased links a garment
added_at                 DATETIME
purchased_at             TEXT
```

### 3.5 `wr_user_profile` (singleton, id=1)

```
id                       INTEGER primary key CHECK (id = 1)
reference_image_path     TEXT     -- full-body selfie for virtual mirror
preferred_brands         TEXT     -- JSON; seeded ["Lacoste","Lululemon"]
sizing                   TEXT     -- JSON per-category
style_notes              TEXT
updated_at               DATETIME
```

> **Note**: a `morning_outfit_enabled` column was considered and removed before shipping — the opt-out for the morning proactive job is just the per-job `enabled` toggle on the `/tasks` page, so a duplicate flag was redundant.

## 4. Shared infrastructure

### 4.1 Image storage

Filesystem layout under `${DATA_DIR}/wardrobe/`:

```
wardrobe/
  garments/{source_id}/original.{jpg|png}   -- full-frame upload
  garments/{source_id}/crop_{i}.jpg         -- per-item crop
  outfits/{outfit_id}/render.jpg            -- virtual mirror output
  profile/reference.{jpg|png}               -- reference selfie
```

Served by agent at `/internal/wardrobe/images/*` (path-traversal guarded). Proxied to the browser (behind the web auth layer) via `apps/web/src/app/wardrobe_images/[...path]/route.js`.

### 4.2 Model selection

All via `configService.getModel(key)`:

- `FLASH` (`WORKER_FLASH` env) — detection, per-crop attribute refinement, grounded brand search
- `PRO` (`WORKER_PRO` env) — hybrid matcher, outfit recommender, critique, trip packer
- `IMAGE` (`GEMINI_IMAGE_MODEL` env) — virtual mirror

### 4.3 Socket.io events

Namespaced `wardrobe:*`:

- `wardrobe:garment:detected` — placeholder row created
- `wardrobe:garment:attributes` — refinement landed
- `wardrobe:garment:enriched` — brand pass complete (status final)
- `wardrobe:garment:update` / `wardrobe:garment:delete` — generic
- `wardrobe:outfit:update` / `wardrobe:outfit:rendered`
- `wardrobe:trip:update`
- `wardrobe:shopping:update`

### 4.4 Weather (subagent pattern)

Any forecast need calls:

```js
const result = await agent.subAgentService.spawn({
  task: `Get daily forecast for ${location} from ${startDate} to ${endDate}.
Return JSON: {days: [{date, tempMin, tempMax, condition, precipitationMm}]}.
Dates MUST be in YYYY-MM-DD format.`,
  tools: ['runShellCommand'],
  waitForResult: true,
  lightweight: true,
});
```

The sub-agent uses the existing weather skill ([SKILL.md](../apps/agent/skills/weather/SKILL.md)).

### 4.5 Cross-transport photos

Agent webhook at [apps/agent/src/server.js](../apps/agent/src/server.js) accepts `{parts: [{inlineData: {mimeType, data}}]}` regardless of source. Producers:

- Web upload → API proxy → agent
- WhatsApp ([whatsapp.js](../apps/interfaces/src/whatsapp.js)) — already builds `inlineData` from `imageMessage`
- Telegram ([telegram.js](../apps/interfaces/src/telegram.js)) — `photo` handler added in P4; fetches largest size, base64-encodes, forwards with caption

### 4.6 Security

- `/v1/wardrobe/*` is protected by `authMiddleware` (Bearer `DEEDEE_API_TOKEN`) in `apps/api/src/server.js`. Mounted after the global `app.use('/v1', authMiddleware)` — same pattern as `/v1/dj`.
- `/internal/wardrobe/*` is mounted on the agent at port 3000, only reachable inside the Docker network.
- Image proxy has defense-in-depth path-traversal checks on both the Next.js web route and the agent handler.

## 5. Tool surface (28 tools, category `wardrobe`)

Registered in [apps/agent/src/tools-definition.js](../apps/agent/src/tools-definition.js), handled by `WardrobeExecutor` at [apps/agent/src/executors/wardrobe.js](../apps/agent/src/executors/wardrobe.js).

Generic-sounding names are prefixed with `wardrobe_` to avoid future collisions (travel booking, calendar tools, etc.):

```
# Garments
add_garment, list_garments, get_garment, search_garments,
update_garment, delete_garment, confirm_brand

# Outfits
analyze_outfit_photo, recommend_outfit, visualize_outfit,
critique_outfit, like_outfit, list_outfits

# Trips (wardrobe_-prefixed)
wardrobe_pack_for_trip, list_wardrobe_trips, get_wardrobe_trip,
start_wardrobe_trip, complete_wardrobe_trip,
set_wardrobe_trip_capsule, add_to_wardrobe_trip_capsule,
remove_from_wardrobe_trip_capsule

# Shopping list
add_to_shopping_list, list_shopping_items,
mark_wardrobe_item_purchased, dismiss_shopping_item

# Profile
get_wardrobe_profile, update_wardrobe_profile, set_reference_selfie
```

See [docs/wardrobe.md](../docs/wardrobe.md) for full signatures.

## 6. Shipped phases

| # | Goal | Key deliverable |
|---|---|---|
| P1 | Foundation | 5 SQLite tables, service skeleton, mobile-first `/wardrobe` page, Socket.io, Lacoste/Lululemon seeded |
| P2 | Multi-item detection | Gemini Flash bbox detection, `sharp` cropping, background attribute pass; defensive bbox normalization (0-1, 0-1000, reversed, malformed) |
| P3 | Strict brand enrichment | Grounded search with preferred-brand bias, confidence ≥ 0.95 + visual identifier required, `needs_brand_confirm` state + UI chip |
| P4 | Cross-transport photos | Telegram `photo` handler added; WhatsApp already sends `inlineData` |
| P5 | `analyze_outfit_photo` | Unified hybrid primitive (match + auto-add), shopping crossref, trip-scoped shortlist (capsule prepended, wardrobe still included) |
| P6 | `recommend_outfit` | 4-bucket output (weather/occasion/item/safe_repeat), liked-outfit bias, `wants[]` → shopping list |
| P7 | Virtual mirror (single) | `gemini-3-pro-image-preview`, reference selfie onboarding |
| P8 | Multi-mirror | 1-4 panels, auto layout (single/horizontal/grid) |
| P9 | `critique_outfit` | 0-10 score, strengths/weaknesses, alternative from valid wardrobe ids only |
| P10a | `wardrobe_pack_for_trip` | Weather subagent + Pro reasoning → capsule + per-day plan |
| P10b | Live trip capsule | `start/complete` + `set/add/remove` capsule, editable during active trip |
| P11 | Shopping list | CRUD + ingest-time crossref hook + `wants[]` auto-insert |
| P12 | Proactive nudges | `wardrobe_pretrip_check` (daily 08:00) + `wardrobe_morning_outfit` (daily 07:15) as scheduler system jobs; opt-out via `/tasks` toggle |

## 7. Testing

- **Unit**: 72/72 tests pass in [apps/agent/tests/wardrobe.test.js](../apps/agent/tests/wardrobe.test.js). Covers bbox normalization, multi-item ingest, full-frame bypass, crop-failure fallback, background attribute pass, brand enrichment (auto-accept, needs-confirm, low-confidence, no features, API error, Lacoste/Lululemon bias in prompt), confirmBrand accept/reject, analyzeOutfitPhoto (match + auto-add, hallucination → NEW, no client → all NEW, trip-scoped shortlist), recommendOutfit (empty pool, stub fallback, 4-bucket parsing, phantom id filter, wants[] → shopping), visualizeOutfit (needs_reference, 1/3/4 panels with layout, supplied outfit_id, invalid outfit_id throws, no image returned, no panels throws), critiqueOutfit (required args, valid alternative, hallucination filter, null alternative), all trip CRUD, shopping CRUD + crossref, renamed-tool executor routing, profile tools.
- **Pattern**: Jest with mocked Gemini client and filesystem, following [apps/agent/tests/dj.test.js](../apps/agent/tests/dj.test.js) conventions.
- **No regressions**: 41/41 DJ tests still pass. 371/377 total agent tests (the 6 pre-existing failures in `commands.test.js` and `watchers.test.js` exist on master and are unrelated).

## 8. Open items

- Dedicated UI pages for outfits, trips, and shopping list. Current `/wardrobe` page covers P1–P3 UX; outfit/trip/shopping are agent-chat-driven.
- Embedding-based garment similarity (CLIP or Gemini embeddings) — potential replacement for the hybrid matcher when wardrobe grows beyond ~80 items.
- `wr_critiques` persistence table — deferred; currently critiques are ephemeral.
- Multi-user — out of scope; `wr_user_profile` is a singleton.
- P13 "Gap analysis at store" — designed, not yet shipped. See section below.

## 9. Post-MVP / future phases

### P13 — Gap analysis at store

User photographs a candidate item and asks "should I buy this?" The agent virtually inserts it, regenerates outfits, reports marginal utility vs. redundancy with existing pieces, and (with `times_worn` signal) projects a cost-per-wear. Returns `{marginal_new_outfits, redundant_with, estimated_cpw_cents?, recommendation: 'buy'|'skip'|'maybe'}`.

## 10. Appendix — key prompts

All prompts live in [apps/agent/src/services/wardrobe-service.js](../apps/agent/src/services/wardrobe-service.js) (not externalized) and pass through `configService.getModel(...)` for model selection.

### A.1 Multi-item detection (FLASH, `responseMimeType: 'application/json'`)
Requests a strict JSON array of items with bbox (normalized 0..1), type, subtype, color, pattern, material, warmth, formality, season_tags, distinguishing_features, detection_confidence.

### A.2 Hybrid match (PRO, `responseMimeType: 'application/json'`)
Receives primary photo + up to 25 numbered wardrobe item crops. Returns `{matches: [{detection_index, match: "<id>|NEW"}]}`. Anti-hallucination: ids not in the shortlist are treated as NEW.

### A.3 Per-crop attribute refinement (FLASH, JSON)
Cleaner second-pass extraction from a single garment crop. Fills `meta.attributePassRaw` and patches the row.

### A.4 Brand enrichment (FLASH + `tools: [{googleSearch: {}}]`)
Grounded search. Injects preferred-brands hint. Requires `visual_identifier_cited` + `confidence ≥ 0.95` for auto-accept.

### A.5 Outfit recommendation (PRO, JSON)
4-bucket output. Includes liked-outfit examples. Emits optional `wants[]`. Filters phantom ids.

### A.6 Virtual mirror (IMAGE, `responseModalities: ['TEXT','IMAGE']`)
Prompt varies by panel count: single-panel mirror-selfie framing vs. N-panel side-by-side with numeric labels. Consistent lighting/pose across panels.

### A.7 Critique (PRO, JSON)
Score 0-10, strengths/weaknesses citing pieces, `better_alternative.garment_ids` limited to valid wardrobe ids only.

### A.8 Trip packing (PRO, JSON)
Receives weather forecast (from subagent), wardrobe pool, activities. Returns `{capsule, daily, rationale}`. Capsule ids filtered against valid wardrobe.
