# DJ Assistant 🎧

Deedee includes a specialized **DJ Module** that acts as your Crate Digger and Booth Buddy.

## Features

1.  **Vinyl Ingestion ("Crate Digger")**:
    -   **Vision Powered**: Take a photo of a vinyl cover, center label, or receipt.
    -   **Auto-Tagging**: Extracts Artist, Title, Label, and Catalog Number via Gemini Vision.
    -   **Multi-Source Enrichment**: Cascading metadata lookup through three tiers:
        1.  **Discogs API** (primary) — structured tracklist, cover art, genre, year, label, RPM. Requires `DISCOGS_TOKEN` env var (free personal access token). Searches by catalog number first, then artist+title, then free-text.
        2.  **MusicBrainz + Cover Art Archive** (secondary) — tracklist, high-res cover art. Free, no auth needed. Fills gaps if Discogs misses.
        3.  **Gemini + Google Search grounding** (fallback) — BPM, key (Camelot notation), and any remaining metadata. Also provides per-track BPM/key enrichment for tracks still missing data.
    -   **Cover Art Download**: Tries multiple image URLs from Discogs, Cover Art Archive, and Gemini with redirect handling; falls back to uploaded photo.
    -   **Confidence Tracking**: Enrichment results carry a confidence score (0–1) visible in the UI.
    -   **Persistence**: Saves to `dj_vinyls` table + cover image to `data/vinyl_covers/`.
    -   **Usage**: Send image via Chat, WhatsApp, or upload directly from the DJ Crate page.

2.  **Recommendation Engine ("Booth Buddy")**:
    -   **Context Aware**: Knows what you are playing (Key, BPM, Vibe).
    -   **Vinyl First**: Can recommend tracks *specifically* from your physical crate.
    -   **Digital**: Can recommend digital tracks from history or general knowledge.
    -   **Usage**: "What should I mix with 'Move Your Body'?" or "Recommend a vinyl for this vibe."

3.  **Non-blocking Enrichment**:
    -   **Instant Upload**: Upload returns immediately with a placeholder card — no waiting for enrichment.
    -   **Background Pipeline**: Enrichment (Discogs → MusicBrainz → Gemini) runs asynchronously via fire-and-forget.
    -   **Live Progress**: Socket.io broadcasts `dj:vinyl:enriching` on start, `dj:vinyl:update` on completion.
    -   **Failure Recovery**: Failed enrichments show a retry badge; `POST /vinyls/:id/retry-enrich` restarts the pipeline.
    -   **Parallel Uploads**: Upload multiple vinyls simultaneously — each enriches independently.
    -   **Status Tracking**: `enrichment_status` column (`enriching`, `complete`, `failed`) on each vinyl row.

4.  **Hidden Gems (Price & History)**:
    -   **Market Value**: Fetches Discogs marketplace price suggestions (median, low, high, listings count).
    -   **Release History**: AI-generated 2-3 sentence blurb about the release's significance via Gemini + Google Search grounding.
    -   **Auto-fetch**: Price and history are fetched during enrichment pipeline (non-blocking, `Promise.allSettled`).
    -   **Manual Refresh**: `POST /vinyls/:id/value` re-fetches price + history without full re-enrichment.
    -   **UI**: "Market Value" section in detail modal with emerald accent; "About this Release" section below.

5.  **Collections & Crates**:
    -   **Manual Crates**: Group vinyls into named collections. Add/remove vinyls via card hover button or detail modal.
    -   **Smart Crates**: Auto-filtering collections based on rules (genre, style, year range, BPM range, label, RPM).
    -   **Crate Strip**: Horizontal scrollable pill tabs above the search bar — "All Vinyls" default + user crates + "+" button.
    -   **Crate Modal**: Create/edit crate with name, type toggle (manual/smart), icon, and rule inputs.
    -   **Remove from Crate**: "Remove from Crate" button in detail modal when viewing a manual crate.

6.  **DJ Crate UI** (`/dj`):
    -   **Grid View**: Responsive grid (2 cols mobile → 5 cols desktop).
    -   **Multi-token Search**: Filter by artist, title, label, genre, style, catalog number. All search tokens must match.
    -   **Detail Modal**: Click any vinyl to see full metadata, tracklist with per-track BPM/Key, market value, history, and external links.
    -   **Inline Editing**: Edit all fields including per-track BPM and Key (Camelot notation).
    -   **Confidence Badges**: Low/Medium confidence enrichments are visually flagged.
    -   **RPM Badges**: Shows 33/45/78 RPM on cards.
    -   **Enrichment Spinners**: Cards show spinner overlay while enrichment is in progress.
    -   **Real-time Updates**: Socket.io events refresh cards instantly (enriching, update, delete).
    -   **Direct Upload**: Upload vinyl photos directly from the web UI.
    -   **Mobile Friendly**: Bottom-sheet modal, touch-optimized targets, hidden hover overlays on touch.

## Data Model

### `dj_vinyls` Table
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `artist` | TEXT | Artist name |
| `title` | TEXT | Release title |
| `label` | TEXT | Record label |
| `catalog_number` | TEXT | Catalog number |
| `cover_image_url` | TEXT | Relative path to cover image |
| `bpm` | INTEGER | Reserved (BPM is per-track) |
| `key` | TEXT | Reserved (Key is per-track) |
| `tracks` | JSON | Array of `{ position, title, bpm, key }` |
| `meta` | JSON | See Meta Schema below |
| `enrichment_status` | TEXT | `enriching`, `complete`, or `failed` (default: `complete`) |

### Meta Schema
```json
{
  "genre": "Techno",
  "style": "Acid",
  "year": 1992,
  "rpm": 33,
  "discogsUrl": "https://discogs.com/release/...",
  "beatportUrl": null,
  "enrichmentConfidence": 0.85,
  "originalCoverUrl": "/vinyl_covers/original.jpg",
  "priceGuide": {
    "median": 12.50,
    "lowest": 4.00,
    "highest": 45.00,
    "currency": "USD",
    "numForSale": 23,
    "lastChecked": "2026-03-09T..."
  },
  "history": "2-3 sentence blurb about the release's significance..."
}
```

### `dj_crates` Table
| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `name` | TEXT | Crate name (max 100 chars) |
| `type` | TEXT | `manual` or `smart` |
| `rules` | JSON | Smart crate filter rules (see below) |
| `icon` | TEXT | Emoji icon (max 10 chars) |
| `color` | TEXT | CSS color string (max 20 chars) |
| `created_at` | TEXT | ISO timestamp |

### `dj_crate_vinyls` Table (Join)
| Column | Type | Description |
|---|---|---|
| `crate_id` | TEXT | FK → `dj_crates.id` (CASCADE delete) |
| `vinyl_id` | TEXT | FK → `dj_vinyls.id` (CASCADE delete) |
| `added_at` | TEXT | ISO timestamp |

### Smart Crate Rules
```json
{
  "genre": "Techno",
  "style": "",
  "yearMin": 1990,
  "yearMax": 2005,
  "bpmMin": 130,
  "bpmMax": 145,
  "label": "",
  "rpm": 33
}
```
Empty/null/0 fields are ignored (no filter on that dimension).

### Tracks Schema
```json
[
  { "position": "A1", "title": "Track Name", "bpm": 128, "key": "8A" },
  { "position": "B1", "title": "Another Track", "bpm": 124, "key": "11B" }
]
```
Keys use **Camelot notation** (1A–12B) for DJ harmonic mixing.

## API Endpoints

### Agent (Internal)

#### Vinyl Routes
| Method | Path | Description |
|---|---|---|
| GET | `/internal/dj/vinyls` | List vinyls (query: `limit`, `offset`) |
| POST | `/internal/dj/vinyls/upload` | Upload vinyl photo (body: `{ image, mimeType }`). Returns placeholder immediately; enrichment runs in background. |
| PUT | `/internal/dj/vinyls/:id` | Update vinyl fields |
| DELETE | `/internal/dj/vinyls/:id` | Delete vinyl and its cover image |
| POST | `/internal/dj/vinyls/:id/enrich` | Re-enrich vinyl metadata (full cascade pipeline) |
| POST | `/internal/dj/vinyls/:id/value` | Refresh price guide + history only (no cascade re-enrich) |
| POST | `/internal/dj/vinyls/:id/retry-enrich` | Retry failed enrichment (non-blocking) |
| GET | `/internal/dj/covers/*` | Static file server for cover images |

#### Crate Routes
| Method | Path | Description |
|---|---|---|
| GET | `/internal/dj/crates` | List all crates |
| POST | `/internal/dj/crates` | Create crate (body: `{ name, type, rules?, icon?, color? }`) |
| PUT | `/internal/dj/crates/:id` | Update crate fields |
| DELETE | `/internal/dj/crates/:id` | Delete crate (cascade removes memberships) |
| GET | `/internal/dj/crates/:id/vinyls` | Get vinyls in crate (manual: members; smart: rule-matched) |
| POST | `/internal/dj/crates/:id/vinyls/:vinylId` | Add vinyl to manual crate |
| DELETE | `/internal/dj/crates/:id/vinyls/:vinylId` | Remove vinyl from manual crate |

### API Gateway (Public, Auth Required)

All `/v1/dj/*` routes are protected by `authMiddleware` (Bearer Token: `DEEDEE_API_TOKEN`).

#### Vinyl Routes
| Method | Path | Description |
|---|---|---|
| GET | `/v1/dj/vinyls` | Proxy → Agent GET |
| POST | `/v1/dj/vinyls/upload` | Proxy → Agent POST (10MB limit) |
| PUT | `/v1/dj/vinyls/:id` | Proxy → Agent PUT |
| DELETE | `/v1/dj/vinyls/:id` | Proxy → Agent DELETE |
| POST | `/v1/dj/vinyls/:id/enrich` | Proxy → Agent re-enrich |
| POST | `/v1/dj/vinyls/:id/value` | Proxy → Agent refresh value |
| POST | `/v1/dj/vinyls/:id/retry-enrich` | Proxy → Agent retry enrich |

#### Crate Routes
| Method | Path | Description |
|---|---|---|
| GET | `/v1/dj/crates` | Proxy → Agent GET crates |
| POST | `/v1/dj/crates` | Proxy → Agent POST crate |
| PUT | `/v1/dj/crates/:id` | Proxy → Agent PUT crate |
| DELETE | `/v1/dj/crates/:id` | Proxy → Agent DELETE crate |
| GET | `/v1/dj/crates/:id/vinyls` | Proxy → Agent GET crate vinyls |
| POST | `/v1/dj/crates/:id/vinyls/:vinylId` | Proxy → Agent add vinyl to crate |
| DELETE | `/v1/dj/crates/:id/vinyls/:vinylId` | Proxy → Agent remove vinyl from crate |

## Technical Details

-   **Database**: SQLite `dj_vinyls` table with JSON columns for tracks and meta.
-   **Images**: Stored in persistent volume `data/vinyl_covers/`, served by Agent at `/internal/dj/covers`.
-   **Models**:
    -   **Vision Analysis**: `WORKER_FLASH` (Gemini Flash) for image parsing.
    -   **Metadata Enrichment**: Cascading pipeline — Discogs API → MusicBrainz/CAA → `WORKER_FLASH` with Google Search grounding (fallback for BPM/key).
    -   **Recommendation**: `WORKER_PRO` (Gemini Pro) for musical reasoning.
-   **External APIs**:
    -   **Discogs** (`DISCOGS_TOKEN`): Free, 60 req/min. Provides structured tracklist, cover art, genre, year, RPM.
    -   **MusicBrainz**: Free, no auth, 1 req/sec rate limit. Provides tracklist and release metadata.
    -   **Cover Art Archive**: Free, no auth. Provides high-res cover art linked to MusicBrainz releases.
-   **Socket Events**:
    -   `dj:vinyl:update` — broadcast on enrichment complete or manual edit. Payload: full vinyl object.
    -   `dj:vinyl:delete` — broadcast on vinyl deletion. Payload: `{ id }`.
    -   `dj:vinyl:enriching` — broadcast when enrichment starts. Payload: `{ id, artist, title, status: 'enriching' }`.
