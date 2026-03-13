---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: {"moltbot":{"emoji":"🌤️","requires":{"bins":["curl"]}}}
---

# Weather

> **IMPORTANT**: This is a SKILL, not an MCP server. To run any command below, use the `runShellCommand` tool.

Two free services, no API keys needed.

## wttr.in (primary)

**Always use the compact format** (keeps output small, avoids truncation):
```bash
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"
# Output: London: ⛅️ +8°C 71% ↙5km/h
```

Format codes: `%c` condition · `%t` temp · `%h` humidity · `%w` wind · `%l` location · `%m` moon

Tips:
- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/JFK`
- Units: `?m` (metric) `?u` (USCS)

Only if the user explicitly asks for a detailed multi-day forecast:
```bash
curl -s "wttr.in/London?T&1"
```

## Open-Meteo (fallback, JSON)

Free, no key, good for programmatic use:
```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```

Find coordinates for a city, then query. Returns JSON with temp, windspeed, weathercode.

Docs: https://open-meteo.com/en/docs
