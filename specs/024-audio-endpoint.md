# Spec 024: Audio Endpoint

## Background
The user requires a way to send raw audio files (iOS Dictation, Voice Notes) directly to the Agent, bypassing iOS's limited dictation capabilities. This allows the Agent's multimodal LLM (Gemini) to handle speech-to-text and intent understanding, enabling multi-language support.

## Endpoint Definition

- **URL**: `POST /v1/chat/audio`
- **Authentication**: Bearer Token (`DEEDEE_API_TOKEN`)
- **Content-Type**: `multipart/form-data`

### Parameters
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `file` | File | Yes | The audio file (wav, mp3, ogg, etc.). Max 10MB. |
| `source` | String | No | Source identifier. Default: `ios_shortcut`. |
| `chatId` | String | No | Chat session ID. Default: `audio_chat`. |

### Response
```json
{
  "success": true,
  "agentResponse": {
    "replies": [
      {
        "role": "assistant",
        "content": "I heard you say...",
        "source": "api"
      }
    ]
  }
}
```

## Implementation Details
- **API Service**: Uses `multer` (memory storage) to buffer the upload. Converts buffer to Base64.
- **Agent Service**: Receives a standard `UserMessage` with a `parts` array containing the inline audio data.
- **Handling**: The Agent treats this as a multimodal input. The System Prompt includes a "DICTATION SAFEGUARD" (implied for `ios_shortcut`) to handle ambiguities carefully.

## Security
- Protected by the same High-Level Auth Middleware as other `/v1` routes.
- File size limit enforced (10MB).
