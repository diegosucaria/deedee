# Specification: Deedee DJ Helper Module (Rev 2)

## 1. Overview
This module adds musical intelligence to Deedee, acting as a "B2B" partner.
It is strictly divided into two modes:
1.  **Vinyl Mode (Collector/Home)**: Digitizing an analog collection and recommending tracks *only* from that crate.
2.  **Digital Mode (Prep/Club)**: Exploring new music, analyzing history, and recommending based on a global search + user library.

**Global Mandate**: All DJ intelligence tools MUST use **Gemini 1.5 Pro** (or equivalent "Pro" model).

## 2. User Stories

### 2.1 The Vinyl Crate (Collector Mode)
*   **Trigger**: User sends a photo of a Vinyl Record (Cover or Center Label) with command `/vinyl`.
*   **Problem**: Vinyl labels often lack tracklists or BPMs.
*   **Action**:
    1.  **Vision**: Deedee extracts visible text (Catalog Number, Label, Artist, Title).
    2.  **Search**: Deedee **searches online** (Discogs/Google) using the extracted data to find the full release metadata (Tracklist, Genre, Year).
    3.  **Ingestion**: Saves the release and its tracks to the `dj_library` (Vinyl partition).
*   **Recommendations**:
    *   Trigger: "What should I play after [Vinyl X]?"
    *   Constraint: **STRICTLY Vinyl Only**. Do not suggest digital tracks. The goal is to mix with what I physically have.

### 2.2 Digital Prep Mode (The Booth Buddy)
*   **Trigger**: User asks for a recommendation or uploads a playlist history.
*   **Context**: User's past sets (History) + Global Music Knowledge.
*   **History Ingestion**:
    *   User uploads `.txt` or `.m3u8` history files.
    *   Action: Save to **"DJ Vault"** (Agent Vaults). Do not ingest into structured DB table.
    *   Usage: Agent uses RAG/Search on the DJ Vault to understand style and past transitions.
*   **Recommendations**:
    *   Trigger: "I'm playing [Track A], give me 3 options."
    *   Logic:
        1.  Analyze Current Track (BPM, Key, Energy).
        2.  Search: Global Internet + Digital Library + History Vault.
        3.  Output: 3 distinct paths (Smooth, Lift, Pivot).

## 3. Data Architecture

### 3.1 Database (`dj_vinyls`)
Table designed **strictly** for the Vinyl Crate.
*   `id`: UUID
*   `artist`: Text
*   `title`: Text
*   `label`: Text
*   `catalog_number`: Text
*   `cover_image_url`: Text (For the "Digitalized Crate" gallery)
*   `bpm`: Real
*   `key`: Text
*   `tracks`: JSON (List of track names on the vinyl)
*   `meta`: JSON (Year, Genre, Discogs Link)

### 3.2 Vaults (`dj_history`)
*   **Storage**: Stores playlist history files (`.txt`, `.m3u8`, `.csv`).
*   **Metadata**: Critical. Each file MUST be accompanied by context:
    *   **Venue**: Where it was played (e.g., "Club X", "Home").
    *   **Date**: When it was played.
    *   **Party/Event**: Name (e.g., "Bizarre Music Party").
*   **Ingestion**: User tells the Agent context -> Agent saves file + context to Vault.
*   **Usage**: "What did I play at Club X?" -> Agent retrieves relevant history.

### 3.3 Tools & Logic

#### `addVinyl(image)`
1.  **Vision**: `Gemini Flash` (Model defined in `WORKER_FLASH` env var) -> Extract Artist, Title, Label, Catalog Number, visible tracklist.
2.  **Cascading Enrichment**:
    1.  **Discogs API** (`DISCOGS_TOKEN`): Search by catalog number → artist+title → free-text. Fetches structured tracklist, cover art URLs, genre, year, RPM. Free tier, 60 req/min.
    2.  **MusicBrainz + Cover Art Archive**: Secondary source for tracklist and high-res cover art. Free, no auth, 1 req/sec rate limit.
    3.  **Gemini + Google Search grounding** (fallback): Fills BPM/key (Camelot notation) and any remaining gaps. Per-track parallel searches for tracks still missing BPM/key.
3.  **Cover Art**: Downloads from multiple candidate URLs (Discogs images, Cover Art Archive, Gemini URLs) with HTTP redirect following. Falls back to uploaded photo.
4.  **Save**: Insert into `dj_vinyls`.

#### `ingestHistory(file, metadata)`
1.  **Input**: text/file content + Metadata (Venue, Date, Party).
2.  **Action**: Save to `dj_history` Vault.
3.  **Format**: Save as Markdown with Frontmatter or structured text to allow easy RAG.

#### `recommendVinyl(currentTrack)`
1.  **Source**: `SELECT * FROM dj_vinyls`.
2.  **Logic**: Filter by BPM/Key compatibility.
3.  **Model**: `WORKER_PRO`.

#### `recommendDigital(currentTrack)`
1.  **Source**: Global Knowledge + `dj_history` Vault.
2.  **History Context**: RAG must favor histories with similar "Vibe" or explicitly requested context (e.g. "Like the Bizarre Party").
3.  **Prompt**: "Expert DJ" System Persona.
4.  **Output**: 3 Paths (Smooth, Lift, Pivot).

#### Slash Commands
*   `/track [track_name]`: Quick recommendation trigger.
*   `/track [image]`: Vision-based recommendation (OCR CDJ screen).
*   `/vinyl [image]`: Add to crate.

## 4. System Prompt (Expert DJ)
(See `apps/agent/src/prompts/dj.js`)
*   **Persona**: Expert DJ & Music Theorist.
*   **Goal**: 3 Distinct Mixing Paths (Smooth, Lift, Pivot).
*   **Style**: Concise, Technical, "B2B" partner vibes.
*   **Format**: Strict output format (Analysis | Option 1 | Option 2 | Option 3).

## 5. UI Requirements
*   **Vinyl Crate Gallery**: A simple visual grid to *browse* the collection.
*   **Ingestion**: Primary method is **Chat** (Slash commands / File Upload). UI is secondary.