# Pilotfy MCP Server

An MCP server that lets DeeDee (or any MCP client) view aircraft availability and
make/cancel bookings at a flight school served by **Pilotfy**'s legacy
"school-turns" API — e.g. **Aero Club Córdoba** (`schoolId 34`, aerodrome EDO,
hours 06:00–21:00, bookable 2 weeks ahead, max 10 turns/user).

Single-file [`server.py`](server.py), built on FastMCP — same pattern as
[`../../plex-mcp-server`](../../plex-mcp-server) and [`../browser-use`](../browser-use).

API details were verified live and are documented at
[github.com/diegosucaria/pilotfy-calendar](https://github.com/diegosucaria/pilotfy-calendar).
The civil-twilight algorithm is ported verbatim from that repo's app (and
cross-checked bit-for-bit against the original JavaScript).

## Tools

| Tool | Kind | Description |
|------|------|-------------|
| `whoami()` | read | My name, my school, and the school's turn rules (hours, book-ahead weeks, max turns), plus token expiry. |
| `list_aircraft()` | read | The fleet — id, registration, brand, model, status (`active` = bookable). |
| `get_availability(date)` | read | For `YYYY-MM-DD`, per active aircraft: the **busy** turns (time, pilot, instructor, reason, status) and the **free gaps** within school hours. Includes sunrise/sunset + civil dawn/dusk for the aerodrome. |
| `my_turns(include_past=False)` | read | My reservations (upcoming by default), with status, aircraft, instructor, reason, and my active-turn count vs. the per-user max. |
| `book_turn(planeId, date, timeFrom, timeTo, reason, instructor="", confirm=False)` | **write** | Book a turn. **Refuses unless `confirm=True`** — with `confirm=False` it validates and returns a summary + payload for you to approve. Created as *Pendiente* until the school approves. |
| `cancel_turn(turnId, confirm=False)` | **write** | Cancel one of my turns (status → *Cancelado por piloto*). **Refuses unless `confirm=True`**; otherwise returns a summary for approval. |

`reason` codes: 1 Vuelo Privado · 2 Instrucción Alumno · 3 Readaptación ·
4 Navegación · 5 Bautismo · 6 Adaptación · 7 Vuelo No Regular ·
8 Prueba de Aeronaves · 9 Trabajo Aéreo · 10 Examen.

`instructor` accepts an instructor **name** (case-insensitive substring) or their
**userId**; leave empty for a solo flight.

### Confirmation flow for write actions

`book_turn` / `cancel_turn` perform **real actions at a real aeroclub**. The
assistant should:

1. Call the tool with `confirm=False` (or omit it).
2. Read back the returned `summary` to the user and get an explicit OK.
3. Re-call the **same** tool with `confirm=True` to actually perform it.

`book_turn` validation (run on both calls) checks: date format and the
N-week booking window, `timeTo > timeFrom`, school hours, valid `reason`, the
aircraft exists/is active, no overlap with an existing Pendiente/Aprobado turn,
and the per-user max-turns limit. API errors are surfaced verbatim.

## Configuration (environment variables)

Secrets are **never** hardcoded or logged — they come from the environment.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `PILOTFY_EMAIL` | yes\* | — | Login email. Preferred with `PILOTFY_PASSWORD` because it allows automatic re-login when the token expires. |
| `PILOTFY_PASSWORD` | yes\* | — | Login password. |
| `PILOTFY_TOKEN` | yes\* | — | Alternative to email+password: a raw JWT (no `Bearer`). Cannot self-refresh — when it expires the server errors until you supply a fresh token or email+password. |
| `PILOTFY_BASE` | no | `https://api.pilotfy.com.ar` | API host. |
| `PILOTFY_SCHOOL_ID` | no | auto-detect | Force a school id; otherwise the first active membership from `GET /api/v3/school/user` is used. |
| `PILOTFY_TZ_OFFSET` | no | `-3` | Aerodrome UTC offset (hours) for the sunrise/sunset calc. Argentina = −3. |

\* Provide **either** `PILOTFY_EMAIL` + `PILOTFY_PASSWORD` **or** `PILOTFY_TOKEN`.

The token is cached in memory; on a `401/403` the server re-logs-in **once** and
retries (only possible in email/password mode). Re-login is throttled to avoid
account lockout.

## Use in DeeDee

The server is registered in [`apps/agent/mcp_config.json`](../../../apps/agent/mcp_config.json)
(it merges into the live `data/mcp_config.json` on the next agent reload):

```json
"pilotfy": {
  "command": "python3",
  "args": ["server.py", "--transport", "stdio"],
  "cwd": "../../packages/mcp-servers/pilotfy",
  "env": {
    "PILOTFY_EMAIL": "${PILOTFY_EMAIL}",
    "PILOTFY_PASSWORD": "${PILOTFY_PASSWORD}"
  }
}
```

The `${PILOTFY_EMAIL}` / `${PILOTFY_PASSWORD}` placeholders resolve from the
**agent process environment** — set the real values where DeeDee's other secrets
live (the root `.env` locally, or Balena env vars on the device), exactly like
`PLEX_TOKEN` / `HA_TOKEN`. If neither placeholder is present in the environment,
the agent auto-disables this server at startup (`[MCP] 'pilotfy' disabled: missing env …`)
rather than failing — so it's safe to ship enabled. Optional vars
(`PILOTFY_TOKEN`, `PILOTFY_BASE`, `PILOTFY_SCHOOL_ID`, `PILOTFY_TZ_OFFSET`) are
inherited from the process environment too; add them to the `env` block only if
you want them documented there.

After setting the env vars, hit **Reload** on the Brain → Tools & MCP page (or
restart the agent).

## Standalone usage

```bash
cd packages/mcp-servers/pilotfy
pip install -r requirements.txt

export PILOTFY_EMAIL="you@example.com"
export PILOTFY_PASSWORD="…"        # or: export PILOTFY_TOKEN="<jwt>"

python3 server.py --transport stdio
```

MCP client config (e.g. Claude Desktop):

```json
{
  "pilotfy": {
    "command": "python3",
    "args": ["/abs/path/to/packages/mcp-servers/pilotfy/server.py", "--transport", "stdio"],
    "env": { "PILOTFY_EMAIL": "you@example.com", "PILOTFY_PASSWORD": "…" }
  }
}
```

## Notes & etiquette

- **Reuse the token; don't hammer `signin`** — repeated failed logins can lock the
  account. The server caches the token and only re-logs-in on a 401 (throttled).
- This is an **unofficial, personal** client built from your own account/data.
- Booking creates a *Pendiente* turn; the school still has to approve it.
