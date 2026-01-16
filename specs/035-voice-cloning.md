# Spec 035: Voice Cloning (ElevenLabs)

## Goal
Allow DeeDee to speak with the User's voice (or any custom voice) by integrating a specialized Voice Cloning service.

## Chosen Provider: ElevenLabs
Gemini currently supports a fixed set of voices (`Puck`, `Kore`, `Charon`, etc.). For cloning, we need **ElevenLabs**.

## Architecture Changes

### 1. Configuration
- **New Env Vars**:
    - `ELEVENLABS_API_KEY`: Secret Key.
    - `TTS_PROVIDER`: Enum `gemini` | `elevenlabs`.
- **Settings**:
    - `voice_id`: The ID of the cloned voice.

### 2. Backend (`apps/agent/src/services/tts-service.js`)
Currently, TTS is embedded in `media.js`. We should refactor this into a dedicated service that switches providers.
- `generateAudio(text)`:
    - If `TTS_PROVIDER === 'gemini'`: Call `generateContent`.
    - If `TTS_PROVIDER === 'elevenlabs'`: Call `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`.

### 3. Interface (Voice Cloning UI)
We need a way to **create** the clone.
- **UI**: `apps/web/src/app/settings/voice/page.js`.
- **Features**:
    - "Record Sample": Read a paragraph (approx 1 min).
    - "Upload Sample": Upload MP3/WAV.
    - "Clone": Calls ElevenLabs `POST /v1/voices/add`.
    - "Set Active": Updates `agent_settings` DB.

## Implementation Steps
1.  **Refactor**: Extract TTS logic from `media.js` to `services/tts.js`.
2.  **Integration**: Add ElevenLabs Client.
3.  **API**: Add `POST /v1/voice/clone` endpoint.
4.  **UI**: Add Voice Settings page.

## Estimated Effort
- **Backend Refactor**: 2 hours
- **ElevenLabs Integration**: 2 hours
- **Frontend UI**: 4 hours
**Total**: ~1 Day.
