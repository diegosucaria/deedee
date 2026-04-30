# Wardrobe 👕

Deedee includes a personal **Wardrobe Service** that catalogs your clothes, suggests outfits, renders virtual-mirror previews, plans travel capsules, and maintains a shopping list. Design doc: [specs/047-wardrobe.md](../specs/047-wardrobe.md).

## Features

1.  **Multi-item Photo Catalog**:
    -   **Vision Powered**: Take one photo of multiple garments (a pile on your bed, a store shelf, a flat-lay) — Gemini Flash detects each item with a normalized bounding box plus attributes (type, color, pattern, material, warmth, formality, season).
    -   **Per-item Crops**: Each detection is cropped via `sharp` and stored independently; the full-frame image is preserved as the source.
    -   **Background Refinement**: A per-crop Gemini Flash pass refines attributes with cleaner signal (a second look at just that one item).
    -   **Non-blocking**: Upload returns immediately with placeholder cards; attributes fill in progressively via Socket.io.
    -   **Persistence**: Saves to `wr_garments` table + files under `data/wardrobe/garments/<id>/{original,crop_N}.jpg`.

2.  **Strict Brand Enrichment** (Lacoste / Lululemon bias):
    -   **Grounded Search**: Gemini Flash with Google Search grounding looks up brand/model from the distinguishing features (logos, stitching, named models).
    -   **Confidence Gate**: Auto-accepts the brand **only** when confidence ≥ 0.95 AND a verbatim visual identifier (e.g. "Lacoste crocodile on left chest") is cited.
    -   **User Confirm Flow**: Below-threshold candidates surface as an amber chip on the card + a confirm/reject pair in the detail modal. Stored in `meta.brandCandidate` until resolved.
    -   **Brand Bias**: Your preferred brands (seeded `["Lacoste", "Lululemon"]`) are passed to the search prompt as a prioritization hint — but only if a visual identifier matches.

3.  **Hybrid Chat Flow — `analyze_outfit_photo`**:
    -   **Unified Primitive**: Send a photo of clothes with a question like "what do I wear?" The agent matches every detected item against your existing wardrobe AND auto-adds any unmatched items in a single call.
    -   **Single Pro Match**: One Gemini Pro call receives the primary photo + up to 25 wardrobe candidate crops and returns per-detection matches (or "NEW").
    -   **Anti-hallucination**: Hallucinated match ids are rejected and reclassified as NEW.
    -   **Trip-aware**: If you're on an active trip, capsule items are prepended to the shortlist (but the rest of the wardrobe is still included, so items you didn't formally pack can still be matched).
    -   **Shopping Crossref**: Any newly-added item whose attributes match an open shopping-list item surfaces a prompt to mark that item purchased.

4.  **Outfit Recommendations — `recommend_outfit`**:
    -   **Four Buckets**: Each call returns up to four distinct proposals: `weather_anchored`, `occasion_anchored`, `item_anchored` (when the user references a specific piece), `safe_repeat` (variation on a liked outfit).
    -   **Liked-outfit Bias**: Previously liked outfits are included in the prompt as examples to variate on.
    -   **Wants**: Each proposal may return a `wants[]` array of missing pieces that would elevate the combo. These auto-flow into the shopping list.
    -   **Scope**: Can be pool-restricted to explicit `garment_ids` or to an active trip's capsule.

5.  **Virtual Mirror (1–4 Panels) — `visualize_outfit`**:
    -   **Photorealistic Render**: Uses `gemini-3-pro-image-preview` with a stored reference selfie + garment crops.
    -   **Single-Panel**: Classic mirror-selfie framing of you in one outfit.
    -   **Multi-Panel**: Up to 4 outfits rendered side-by-side in one image (auto layout: single / horizontal row / 2×2 grid).
    -   **Onboarding**: First call without a selfie returns `needs_reference: true`; the agent prompts for one via `set_reference_selfie`.

6.  **Critique — `critique_outfit`**:
    -   **Holistic Score**: Returns 0–10 with specific strengths and weaknesses citing the actual pieces.
    -   **Better Alternative**: Proposes replacement garment_ids from the wardrobe only (anti-hallucination). Scoped to the active trip's capsule if `trip_id` is supplied.
    -   **Accepts**: Either a photo (auto-runs `analyze_outfit_photo` first) or explicit garment_ids.

7.  **Travel Capsules — `wardrobe_pack_for_trip` + Live Edit**:
    -   **Weather Subagent**: Spawns a FLASH sub-agent that runs the existing [weather skill](../apps/agent/skills/weather/SKILL.md) (wttr.in → Open-Meteo fallback) to fetch the daily forecast for the destination.
    -   **Capsule Reasoning**: Gemini Pro plans the minimum-item capsule covering every day with layering/variety, plus a per-day outfit assignment.
    -   **Live Edit**: Once you `start_wardrobe_trip`, the capsule is editable via `set_wardrobe_trip_capsule`, `add_to_wardrobe_trip_capsule` (accepts explicit ids OR a photo — auto-matches via `analyze_outfit_photo`), and `remove_from_wardrobe_trip_capsule`.
    -   **Trip Scoping**: `recommend_outfit(trip_id=...)` and `critique_outfit(trip_id=...)` reason only over the active capsule.

8.  **Shopping List**:
    -   **Sources**: Populated automatically from `recommend_outfit.wants[]` and manually via `add_to_shopping_list`.
    -   **Ingest Crossref**: When a new garment lands via ingestion and its attributes (type + primary_color) match an open wanted item, `meta.shoppingMatch` is annotated — the UI/agent can prompt you to mark purchased.
    -   **Tools**: `list_shopping_items`, `mark_wardrobe_item_purchased` (with optional linked garment_id), `dismiss_shopping_item`.

9.  **Proactive Nudges** (cron-driven, opt-out via the `/tasks` toggle):
    -   **`wardrobe_pretrip_check`** — daily at 08:00. Scans the next 7 days of personal calendar for multi-day trips and drafts packing lists 2–4 days out that aren't already planned.
    -   **`wardrobe_morning_outfit`** — daily at 07:15. Reads your home city from memory, fetches today's weather, summarizes today's calendar, recommends an outfit, and optionally renders it.
    -   Both honor the `[SILENT]` convention — no DM when there's nothing useful to say.

10. **Wardrobe UI** (`/wardrobe`):
    -   **Mobile-first**: 2-col grid default (4–5 on desktop). Native-camera upload button (`capture="environment"`). Bottom-sheet detail modal with inline-editable chips.
    -   **Progressive Enrichment**: "Analyzing N garments…" banner, per-card shimmer chips + "Analyzing" overlay, auto-fill on Socket.io events.
    -   **Brand Confirm Chip**: Amber candidate chip on the card + full confirm/reject in the detail modal when `needs_brand_confirm`.
    -   **Filter Chips**: All / Tops / Bottoms / Outerwear / Shoes / Accessories (horizontal scroll on mobile).
    -   **Auth**: Behind the built-in session cookie like every other `/*` page. The wardrobe image proxy at `/wardrobe_images/*` requires `requireSession()` and forwards a `DEEDEE_INTERNAL_TOKEN` to the agent.

## Data Model

### `wr_garments`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `type` | TEXT | `top`, `bottom`, `shoes`, `outerwear`, `accessory`, `underwear`, `other` |
| `subtype` | TEXT | e.g. `tshirt`, `polo`, `chinos`, `sneakers` |
| `primary_color` | TEXT | Dominant color |
| `secondary_colors` | JSON | Array of accents |
| `pattern` | TEXT | `solid`, `striped`, `plaid`, `graphic`, … |
| `material_guess` | TEXT | e.g. `cotton`, `leather` |
| `warmth` | INTEGER | 1–5 |
| `formality` | INTEGER | 1–5 |
| `season_tags` | JSON | `["spring","summer","fall","winter"]` |
| `brand` / `model` | TEXT | Nullable; set only when confidence gate passes |
| `size` / `fit_notes` | TEXT | User-editable |
| `source_image_path` | TEXT | Absolute path to the original upload |
| `crop_image_path` | TEXT | Absolute path to the per-item crop (equal to source for full-frame detections) |
| `bbox` | JSON | `[x1,y1,x2,y2]` normalized 0..1 |
| `source` | TEXT | `manual_upload`, `auto_from_chat`, `auto_from_trip` |
| `enrichment_status` | TEXT | `enriching`, `complete`, `failed`, `needs_brand_confirm` |
| `enrichment_confidence` | REAL | 0–1 |
| `meta` | JSON | See below |
| `times_worn` / `last_worn_at` | INTEGER / TEXT | Lightweight wear tracking |
| `created_at` | TIMESTAMP | Auto |

### `wr_garments.meta` Schema
```json
{
  "distinguishingFeatures": "small crocodile logo on left chest",
  "detectionRaw": { /* original detection payload */ },
  "attributePassRaw": { /* refinement payload */ },
  "brandCandidate": {
    "brand": "Lacoste",
    "model": null,
    "confidence": 0.82,
    "visualIdentifier": "possibly a crocodile logo"
  },
  "brandVisualIdentifier": "Lacoste crocodile logo on left chest",
  "brandAutoAccepted": true,
  "brandUserConfirmed": true,
  "shoppingMatch": { "id": "sl_1", "description": "army green crew-neck tee" },
  "ingestSource": "analyze_outfit_photo",
  "caption": "what should I wear with these?"
}
```

### `wr_outfits`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `name` | TEXT | Auto-generated (e.g. `weather_anchored`) or user-edited |
| `occasion` | TEXT | Free-text context |
| `weather_tags` | JSON | Array |
| `garment_ids` | JSON | Array of `wr_garments.id` |
| `rendered_image_path` | TEXT | Nullable; set after `visualize_outfit` |
| `liked` | INTEGER | 0/1 — biases future recommendations |
| `last_suggested_at` | TEXT | ISO timestamp |

### `wr_trips`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `calendar_event_id` | TEXT | Nullable link to calendar |
| `destination` / `start_date` / `end_date` | TEXT | YYYY-MM-DD for dates |
| `activities` | JSON | Free-text array |
| `weather_snapshot` | JSON | `{days: [...], daily_plan: [...], pack_rationale: "..."}` |
| `planned_capsule` | JSON | Array of garment_ids from `pack_for_trip` |
| `actual_capsule` | JSON | Array of garment_ids; editable once the trip is `active` |
| `status` | TEXT | `planned`, `active`, `completed` |

### `wr_shopping_list`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `description` | TEXT | Required free-text |
| `type` / `primary_color` / `pattern` / `material_hint` | TEXT | Attribute hints for crossref |
| `suggested_context` | JSON | e.g. `{outfit_id, reason}` when inserted from `wants[]` |
| `priority` | TEXT | `low`, `medium`, `high` |
| `status` | TEXT | `wanted`, `purchased`, `dismissed` |
| `resolved_garment_id` | TEXT | Set when `mark_wardrobe_item_purchased` is passed a garment_id |

### `wr_user_profile` (singleton)
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Always `1` (singleton CHECK) |
| `reference_image_path` | TEXT | Full-body selfie for virtual mirror |
| `preferred_brands` | JSON | Seeded `["Lacoste", "Lululemon"]` |
| `sizing` | JSON | Per-category sizes |
| `style_notes` | TEXT | Free-text style preferences |

## Agent Tools (28 total)

All tools are registered under category `wardrobe`.

### Garments
- `add_garment(image_base64, mime_type?)`
- `list_garments(limit?, offset?, type?)`
- `get_garment(id)`
- `search_garments(query)`
- `update_garment(id, patch)`
- `delete_garment(id)`
- `confirm_brand(garment_id, accept)`

### Outfits
- `analyze_outfit_photo(image_base64, caption?, trip_id?, mime_type?)`
- `recommend_outfit(garment_ids?, trip_id?, context?, count?)`
- `visualize_outfit(garment_ids_panels, layout?, outfit_id?)` — accepts flat array (1 panel) or array-of-arrays (N panels, max 4)
- `critique_outfit(image_base64?, garment_ids?, trip_id?, question?)`
- `like_outfit(outfit_id, liked?)`
- `list_outfits(liked?)`

### Trips (prefixed to avoid collisions)
- `wardrobe_pack_for_trip(destination, start_date, end_date, activities?, calendar_event_id?)`
- `list_wardrobe_trips(status?)`
- `get_wardrobe_trip(id)`
- `start_wardrobe_trip(id)`
- `complete_wardrobe_trip(id)`
- `set_wardrobe_trip_capsule(id, garment_ids)`
- `add_to_wardrobe_trip_capsule(id, garment_ids? | image_base64?)`
- `remove_from_wardrobe_trip_capsule(id, garment_ids)`

### Shopping list
- `add_to_shopping_list(description, type?, primary_color?, pattern?, material_hint?, context?, priority?)`
- `list_shopping_items(status?)`
- `mark_wardrobe_item_purchased(id, garment_id?)`
- `dismiss_shopping_item(id)`

### Profile
- `get_wardrobe_profile()`
- `update_wardrobe_profile(patch)`
- `set_reference_selfie(image_base64, mime_type?)`

## API Endpoints

### Agent (Internal, Docker-network only)

All under `/internal/wardrobe/*`, mounted in `apps/agent/src/server.js`.

| Method | Path | Description |
|---|---|---|
| GET | `/internal/wardrobe/garments` | List (query: `limit`, `offset`, `type`) |
| POST | `/internal/wardrobe/garments/upload` | Ingest photo; returns placeholder rows |
| POST | `/internal/wardrobe/garments/analyze-outfit` | Hybrid match + auto-add; returns `{matched, newly_added, notes}` |
| GET | `/internal/wardrobe/garments/:id` | Detail |
| PUT | `/internal/wardrobe/garments/:id` | Update fields |
| DELETE | `/internal/wardrobe/garments/:id` | Delete + remove image files |
| POST | `/internal/wardrobe/garments/:id/confirm-brand` | `{accept: bool}` |
| GET | `/internal/wardrobe/outfits` | List outfits |
| POST | `/internal/wardrobe/outfits/recommend` | Generate 4-bucket proposals |
| POST | `/internal/wardrobe/outfits/:id/like` | `{liked: bool}` |
| POST | `/internal/wardrobe/outfits/visualize` | Single- or multi-panel render |
| POST | `/internal/wardrobe/outfits/critique` | Score + strengths/weaknesses + alternative |
| GET | `/internal/wardrobe/trips` | List (query: `status`) |
| GET | `/internal/wardrobe/trips/:id` | Detail |
| POST | `/internal/wardrobe/trips/pack` | Plan via weather subagent + Pro reasoning |
| POST | `/internal/wardrobe/trips/:id/start` | status → `active` |
| POST | `/internal/wardrobe/trips/:id/complete` | status → `completed` |
| PUT | `/internal/wardrobe/trips/:id/capsule` | Overwrite `actual_capsule` |
| POST | `/internal/wardrobe/trips/:id/capsule/add` | Append (ids or image) |
| POST | `/internal/wardrobe/trips/:id/capsule/remove` | Remove ids |
| GET | `/internal/wardrobe/shopping` | List (query: `status`) |
| POST | `/internal/wardrobe/shopping` | Add wanted item |
| POST | `/internal/wardrobe/shopping/:id/purchased` | Mark purchased |
| POST | `/internal/wardrobe/shopping/:id/dismiss` | Dismiss |
| GET | `/internal/wardrobe/profile` | Read profile |
| PUT | `/internal/wardrobe/profile` | Update profile |
| POST | `/internal/wardrobe/profile/reference-selfie` | Upload reference selfie |
| GET | `/internal/wardrobe/images/*` | Serve garment / outfit / profile images (path-traversal guarded) |

### API Gateway (Public, Auth Required)

All `/v1/wardrobe/*` routes are protected by `authMiddleware` (Bearer Token: `DEEDEE_API_TOKEN`), mounted in `apps/api/src/server.js` behind the same `app.use('/v1', authMiddleware)` guard as every other `/v1/*` router. Each route is a thin `axios` proxy to the agent's internal equivalent (image-carrying routes use `maxBodyLength: 15MB`).

## Technical Details

-   **Image Storage**: Persistent volume `data/wardrobe/{garments,outfits,profile}/…`. Served by Agent at `/internal/wardrobe/images/*`. Path traversal is guarded on BOTH the Next.js proxy (`wardrobe_images/[...path]/route.js`) and the agent handler.
-   **Models** (all via `configService.getModel(...)` — no hardcoded ids):
    -   **Detection / Attribute Pass / Brand Search**: `FLASH` (env `WORKER_FLASH`, default `gemini-3-flash-preview`).
    -   **Match / Recommend / Critique / Pack**: `PRO` (env `WORKER_PRO`, default `gemini-3.1-pro-preview`).
    -   **Virtual Mirror**: `IMAGE` (env `GEMINI_IMAGE_MODEL`, default `gemini-3-pro-image-preview`).
-   **Weather**: Spawned subagent, not a dedicated service. Uses the shared weather skill at [apps/agent/skills/weather/SKILL.md](../apps/agent/skills/weather/SKILL.md).
-   **Cross-transport Photos**: `apps/interfaces/src/telegram.js` has a `photo` handler; `apps/interfaces/src/whatsapp.js` already forwards images as `inlineData`. The agent webhook at `/webhook` receives a generic `{parts: [{inlineData}]}` shape regardless of source.
-   **Socket Events**:
    -   `wardrobe:garment:detected` — placeholder row created; UI renders skeleton card
    -   `wardrobe:garment:attributes` — refinement landed; skeleton chips fill in
    -   `wardrobe:garment:enriched` — brand pass complete (status final)
    -   `wardrobe:garment:update` / `wardrobe:garment:delete` — generic
    -   `wardrobe:outfit:update` / `wardrobe:outfit:rendered` — outfit changes / render ready
    -   `wardrobe:trip:update` — trip status or capsule change
    -   `wardrobe:shopping:update` — shopping-list row change
-   **Confidence Gate (Brand)**: Two signals required for auto-accept — confidence ≥ **0.95** AND a verbatim visual identifier cited. Below threshold → `needs_brand_confirm` state surfaced in UI.
-   **Ingestion Pipeline** (fire-and-forget chain):
    ```
    detect → crop → addGarment (status='enriching') → emit 'detected'
                 ↓
        _runAttributePass → emit 'attributes' (status still 'enriching')
                 ↓
        _enrichBrand → complete | needs_brand_confirm → emit 'enriched'
    ```
-   **Opt-out for Proactive Jobs**: Toggle the `wardrobe_pretrip_check` and `wardrobe_morning_outfit` rows in the `/tasks` page — the scheduler honors `scheduled_jobs.enabled`.
