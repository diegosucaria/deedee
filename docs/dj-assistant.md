# DJ Assistant 🎧

Deedee includes a specialized **DJ Module** that acts as your Crate Digger and Booth Buddy.

## Features

1.  **Vinyl Ingestion ("Crate Digger")**:
    -   **Vision Powered**: Take a photo of a vinyl cover or a receipt.
    -   **Auto-Tagging**: Extracts Artist, Title, Label, and Catalog Number.
    -   **Persistence**: Saves the vinyl to your digital crate (`dj_vinyls` table) and saves the cover image locally.
    -   **Usage**: Just send an image and say "Add this to my crate" or use `/vinyl`.

2.  **Recommendation Engine ("Booth Buddy")**:
    -   **Context Aware**: Knows what you are playing (Key, BPM, Vibe).
    -   **Vinyl First**: Can recommend tracks *specifically* from your physical crate.
    -   **Digital**: Can recommend digital tracks from history or general knowledge.
    -   **Usage**: "What should I mix with 'Move Your Body'?" or "Recommend a vinyl for this vibe."

3.  **Visualization**:
    -   **Crate View**: Browse your collection at `/dj`.
    -   **Real-time**: Updates instantly when you add a new record.

## Usage Guide

### Adding Vinyls
1.  Go to the **Chat**.
2.  Upload a **Photo** of a record cover.
3.  Caption it: `Add this vinyl` or simple `/vinyl`.
4.  The Agent will analyze it, confirm details, and save it.

### Getting Recommendations
-   **"Suggest a vinyl to mix with [Track Name]"** -> Checks your crate.
-   **"I'm playing [Track Name], what digital track works next?"** -> Checks general knowledge + history.

## Technical Details

-   **Database**: Stores text metadata in `dj_vinyls`.
-   **Images**: 
    -   Stored in persistent volume: `data/vinyl_covers` (Docker Volume).
    -   Served by **Agent** at `/internal/dj/covers`.
    -   Proxied by **Web** at `/vinyl_covers/[filename]` for secure/consistent access.
-   **Models**: 
    -   **Ingestion**: Uses `WORKER_PRO` (Gemini 1.5 Pro) for Vision analysis.
    -   **Recommendation**: Uses `WORKER_PRO` for musical reasoning.
