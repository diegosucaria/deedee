---
name: youtube-summarizer
description: Fetch transcripts from YouTube videos for summarization.
user-invocable: true
injection: on-demand
metadata:
  emoji: 📺
  requires:
    bins: ["youtube_transcript_api"]
  install:
    - id: pip
      kind: pip
      package: youtube_transcript_api
      bins: ["youtube_transcript_api"]
      label: Install YouTube Transcript API (pip)
---

# YouTube Summarizer

Fetch the transcript of a YouTube video so you can summarize it or answer questions about its content.

## Command

**Always use text format** (keeps output small, avoids truncation):
```bash
youtube_transcript_api <VIDEO_ID> --format text
```

## Usage
1. Extract the `VIDEO_ID` from the user's URL (e.g., `dQw4w9WgXcQ`).
2. Run the command.
3. Summarize the plain text transcript for the user.

## Example
**User**: "Summarize this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ"
**Action**: Run `youtube_transcript_api dQw4w9WgXcQ --format text`
