# City Weather Image Feature

## Goal
Generate a "miniature city" image with current weather conditions for a specific city, to be used as a phone wallpaper/lock screen.

## Architecture
1.  **API**: `GET /v1/city-image?city=Name`
2.  **Agent**: Handles the logic chain.
    -   Concept: "Agent, create a weather image for [City]."
    -   Step 1: Agent determines weather (using internal knowledge or tools).
    -   Step 2: Agent constructs the detailed prompt (isometric, 45 deg, text overlay, etc).
    -   Step 3: Agent calls `generateImage` tool (Model: `gemini-3-pro-image-preview`).
    -   Step 4: Returns Image (Base64 or URL).

## new Tool: `generateImage`
-   **Model**: `gemini-3-pro-image-preview`
-   **Input**: `prompt` (string)
-   **Output**: `base64_image` (string)
-   **Env Var**: `GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview`

## Prompt Template
```text
CITY=[CITY], [COUNTRY]

Present a clear, 45° top-down isometric miniature 3D cartoon scene of [CITY], featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions directly into the city environment to create an immersive atmospheric mood.

Use a clean, minimalistic composition with a soft, solid-colored background.

At the top-center, place the title “[CITY]” in large bold text, a prominent weather icon beneath it, then the date (small text) and temperature (medium text).

All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.

The city cartoon should not reach the borders of the image

Instagram Story size, 1080x1920 dimension.
```
