# DJ Assistant 🎧

Deedee includes a specialized **DJ Module** that acts as your Crate Digger and Booth Buddy.

## Features

1.  **Vinyl Ingestion ("Crate Digger")**:
    -   **Vision Powered**: Take a photo of a vinyl cover, center label, or receipt.
    -   **Auto-Tagging**: Extracts Artist, Title, Label, and Catalog Number via Gemini Vision.
    -   **Metadata Enrichment**: Looks up BPM (per track), Key (Camelot notation), Genre, Year, RPM, and Discogs/Beatport URLs via Google Search grounding.
    -   **Cover Art Download**: Downloads album cover from Discogs when available; falls back to uploaded photo.
    -   **Confidence Tracking**: Enrichment results carry a confidence score (0–1) visible in the UI.
    -   **Persistence**: Saves to `dj_vinyls` table + cover image to `data/vinyl_covers/`.
    -   **Usage**: Send image via Chat, WhatsApp, or upload directly from the DJ Crate page.

2.  **Recommendation Engine ("Booth Buddy")**:
    -   **Context Aware**: Knows what you are playing (Key, BPM, Vibe).
    -   **Vinyl First**: Can recommend tracks *specifically* from your physical crate.
    -   **Digital**: Can recommend digital tracks from history or general knowledge.
    -   **Usage**: "What should I mix with 'Move Your Body'?" or "Recommend a vinyl for this vibe."

3.  **DJ Crate UI** (`/dj`):
    -   **Grid View**: Responsive grid (2 cols mobile → 5 cols desktop).
    -   **Search Bar**: Filter by artist, title, label, genre, style, catalog number.
    -   **Detail Modal**: Click any vinyl to see full metadata, tracklist with per-track BPM/Key, and external links.
    -   **Inline Editing**: Edit all fields including per-track BPM and Key (Camelot notation).
    -   **Confidence Badges**: Low/Medium confidence enrichments are visually flagged.
    -   **RPM Badges**: Shows 33/45/78 RPM on cards.
    -   **Real-time Updates**: Socket.io `dj:vinyl:update` event refreshes cards instantly.
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
| `meta` | JSON | `{ genre, style, year, rpm, discogsUrl, beatportUrl, enrichmentConfidence }` |

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
| Method | Path | Description |
|---|---|---|
| GET | `/internal/dj/vinyls` | List vinyls (query: `limit`, `offset`) |
| POST | `/internal/dj/vinyls/upload` | Upload vinyl photo (body: `{ image, mimeType }`) |
| PUT | `/internal/dj/vinyls/:id` | Update vinyl fields |
| GET | `/internal/dj/covers/*` | Static file server for cover images |

### API Gateway (Public, Auth Required)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/dj/vinyls` | Proxy → Agent GET |
| POST | `/v1/dj/vinyls/upload` | Proxy → Agent POST (10MB limit) |
| PUT | `/v1/dj/vinyls/:id` | Proxy → Agent PUT |

All `/v1/dj/*` routes are protected by `authMiddleware` (Bearer Token: `DEEDEE_API_TOKEN`).

## Technical Details

-   **Database**: SQLite `dj_vinyls` table with JSON columns for tracks and meta.
-   **Images**: Stored in persistent volume `data/vinyl_covers/`, served by Agent at `/internal/dj/covers`.
-   **Models**:
    -   **Vision Analysis**: `WORKER_FLASH` (Gemini Flash) for image parsing.
    -   **Metadata Enrichment**: `WORKER_FLASH` with Google Search grounding.
    -   **Recommendation**: `WORKER_PRO` (Gemini Pro) for musical reasoning.
-   **Socket Events**: `dj:vinyl:update` broadcast on add/edit for real-time UI refresh.
