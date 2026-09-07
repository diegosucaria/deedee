# Sanatorio Allende MCP Server

An MCP server that lets DeeDee (or any MCP client) search the Sanatorio Allende
patient portal, read appointment availability, book a slot and cancel a booking,
using the logged-in patient's own account. The patient, their age, sex, contact
details and health cover are all detected from the account — nothing is
configured by hand.

Single-file [`server.py`](server.py), built on FastMCP — same pattern as
[`../pilotfy`](../pilotfy) and [`../../plex-mcp-server`](../../plex-mcp-server).

The API was reverse-engineered from the portal's Angular bundle, where the
request and response shapes are declared as zod schemas, then checked against the
live API. See [Verified and unverified](#verified-and-unverified) for what has
actually been exercised.

> **Unofficial.** Not affiliated with or endorsed by Sanatorio Allende. It talks
> to the portal's API with the patient's own account. The API is undocumented and
> can change without notice.

## Tools

| Tool | Kind | Description |
|------|------|-------------|
| `whoami()` | read | Patient id, age, sex, contact details, health cover, token expiry. Every other tool fills these in automatically. |
| `search_doctors(query)` | read | Free-text search over specialties, services and doctors. **Start here** — it returns every id the other tools need. |
| `list_procedures(idRecurso, idEspecialidad, idServicio, idSucursal)` | read | What a doctor can be booked for, usually CONSULTA and CONSULTA TELEMEDICINA. |
| `earliest_by_specialty(idServicio, idEspecialidad, idSucursal, days=90, idPrestacion=0)` | read | First free slot for **every** doctor in a specialty, soonest first. Answers "who can see me first?". |
| `find_availability(idRecurso, idServicio, idEspecialidad, idSucursal, dateFrom, dateTo, idPrestacion=0, maxDays=15, doctorName="")` | read | Bookable slots for one doctor. Every slot carries the `slot_ref` that books it. |
| `find_earlier(appointmentId, maxDays=15, idPrestacion=0, idEspecialidad=0)` | read | Free slots **earlier** than an appointment the patient already holds, same doctor. |
| `my_appointments(includePast=False, sinceDate="", untilDate="", limit=200)` | read | Booked appointments. The `Id` is what `cancel_appointment` takes. |
| `book_appointment(slot_ref, observaciones="", confirm=False)` | **write** | Book a slot. **Refuses unless `confirm=True`** — with `confirm=False` it runs the portal's own validation and returns a summary to approve. |
| `cancel_appointment(appointmentId, reasonId=4, observaciones="", confirm=False)` | **write** | Cancel a booking. **Refuses unless `confirm=True`**; without it, returns the appointment and the reason list. |

Cancellation reasons: `1` already seen elsewhere · `2` the date is too far off ·
`4` other / rather not say (the default) · `5` medical reason.

### A normal booking

1. `search_doctors("dermatolog")` → the service, specialty and branch ids.
2. `earliest_by_specialty(...)` → every doctor in that specialty and their first free day.
3. `find_availability(...)` → days and times, each with a `slot_ref`.
4. `book_appointment(slot_ref)` → the portal validates; a summary comes back and nothing is booked.
5. Read the summary to the user. On their OK, `book_appointment(slot_ref, confirm=True)`.

### Moving an appointment earlier

1. `my_appointments()` → the appointment the patient holds, with its `Id`.
2. `find_earlier(<Id>)` → free slots before it, same doctor, each with a `slot_ref`.
3. `book_appointment(slot_ref, confirm=True)` → take the earlier slot.
4. Only once that succeeds, `cancel_appointment(<old Id>, confirm=True)`.

Book **before** cancelling. Cancelling first can lose both slots, because anyone
can take the earlier one in between.

### Confirmation flow for write actions

`book_appointment` and `cancel_appointment` change a real booking at a real
hospital. The assistant should:

1. Call the tool with `confirm=False` (or leave it out).
2. Read the returned `summary` — and any `warning` or `confirmation` from the
   portal — back to the user, and get an explicit OK.
3. Call the **same** tool again with `confirm=True`.

Booking is the portal's own two-call flow: `turnos/ValidarAsignar` then
`turnos/Asignar`. The first is what runs on `confirm=False`, so the portal's real
checks (age limits, cover, duplicate visits) surface before anything is booked.
If the portal asks a question back, `confirm=True` answers yes to it.

### Procedure ids

Most specialties book under procedure id 5495, "CONSULTA", which the tools use by
default. Some do not — traumatology and oncology have their own. If a search comes
back empty, call `list_procedures` for one of the specialty's doctors and pass the
right `idPrestacion`.

### Slot references

`slot_ref` is an opaque token holding the slot and the search it came from, so
booking needs no state on the server. Slots get taken by other patients, so fetch
refs fresh rather than reusing old ones. A stale ref fails at `ValidarAsignar`,
before anything is booked.

## Configuration (environment variables)

Secrets are **never** hardcoded or logged — they come from the environment.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ALLENDE_USERNAME` | yes\* | — | The patient's document number. Preferred with `ALLENDE_PASSWORD`, because it allows automatic re-login when the token expires. |
| `ALLENDE_PASSWORD` | yes\* | — | Portal password. |
| `ALLENDE_TOKEN` | yes\* | — | Instead of user + password: a raw JWT. Cannot refresh itself — when it expires the server errors until a fresh one is supplied. |
| `ALLENDE_BASE` | no | `https://miportal.sanatorioallende.com/backend` | API host. |
| `ALLENDE_ID_PACIENTE` | no | from the JWT | Patient id. The login token carries it, so normally leave unset. |
| `ALLENDE_ID_FINANCIADOR` | no | from the patient's cover | Health insurer id. |
| `ALLENDE_ID_PLAN` | no | from the patient's cover | Plan id. |
| `ALLENDE_ID_TIPO_DOCUMENTO` | no | `1` (DNI) | 1 DNI · 2 LC · 3 LE · 4 Passport · 5 CI. |
| `ALLENDE_ENV_FILE` | no | `../.env` | The server also reads this file if present, without overriding real environment variables. Handy when running standalone. |

\* Provide **either** `ALLENDE_USERNAME` + `ALLENDE_PASSWORD` **or** `ALLENDE_TOKEN`.

The token is held in memory and decoded for its expiry. On a `401`/`403` the
server logs in again once and retries, which only works in user/password mode.
Re-login is throttled to 5 seconds to protect the account from lockout.

## Use in DeeDee

The server is registered in [`apps/agent/mcp_config.json`](../../../apps/agent/mcp_config.json)
(it merges into the live `data/mcp_config.json` on the next agent reload):

```json
"allende": {
  "command": "python3",
  "args": ["server.py", "--transport", "stdio"],
  "cwd": "../../packages/mcp-servers/allende",
  "env": {
    "ALLENDE_USERNAME": "${ALLENDE_USERNAME}",
    "ALLENDE_PASSWORD": "${ALLENDE_PASSWORD}",
    "ALLENDE_TOKEN": "${ALLENDE_TOKEN}"
  }
}
```

The `${ALLENDE_*}` placeholders resolve from the **agent process environment** —
set the real values where DeeDee's other secrets live (the root `.env` locally, or
Balena env vars on the device), exactly like `PILOTFY_PASSWORD` / `HA_TOKEN`.
Provide **either** `ALLENDE_USERNAME` + `ALLENDE_PASSWORD` **or** `ALLENDE_TOKEN`;
unset placeholders resolve to empty and are ignored. `ALLENDE_TOKEN` is listed in
the `env` block so token-only setups aren't skipped by the agent's missing-env
check. If **none** of the three are present, the agent auto-disables this server
at startup (`[MCP] 'allende' disabled: missing env …`) rather than failing — so it
is safe to ship enabled.

After setting the env vars, hit **Reload** on the Brain → Tools & MCP page (or
restart the agent).

## Standalone usage

```bash
cd packages/mcp-servers/allende
pip install -r requirements.txt

export ALLENDE_USERNAME="document-number"
export ALLENDE_PASSWORD="…"        # or: export ALLENDE_TOKEN="<jwt>"

python3 server.py --transport stdio
```

MCP client config (e.g. Claude Desktop) — use absolute paths:

```json
{
  "allende": {
    "command": "python3",
    "args": ["/abs/path/to/packages/mcp-servers/allende/server.py", "--transport", "stdio"],
    "env": { "ALLENDE_USERNAME": "document-number", "ALLENDE_PASSWORD": "…" }
  }
}
```

`mcp` 2.x renamed `FastMCP` to `MCPServer`; the server imports whichever is
installed. On 2.x it also accepts `--transport streamable-http`.

## Verified and unverified

Checked against the live API with a real account:

- login, and the `patientId` claim in the JWT
- `whoami`, `search_doctors`, `list_procedures`, `earliest_by_specialty`,
  `find_availability`, `find_earlier`, `my_appointments`
- `turnos/ValidarAsignar` with the exact payload `book_appointment` sends
- **booking, end to end.** A real appointment was booked through
  `book_appointment` and then confirmed in `my_appointments`.

Not exercised against the live API:

- `turnos/CancelarTurno`, the call that cancels. Its payload
  (`{IdTurno, IdMotivoDeAnulacionTurno, Observaciones}`) and the reason codes come
  from the portal bundle's own schema, so the shape is right, but no cancellation
  has been run. Everything `cancel_appointment` does before that call — finding
  the appointment, building the summary — is verified.

### Portal quirks worth knowing

Each of these cost a debugging round, so they are worth keeping written down.

- `ObtenerTurnosParaPortalPorFiltro` returns an **empty list** unless you send
  `FechaHasta`. No error, just nothing.
- The same call silently caps at **10 rows** unless you send `PageSize`. It
  reports the true total in `RowCount`, so compare the two.
- `SoloFuturos` appears to be ignored. Filter by date range instead.
- `Asignar` answers `IdEntidadValidada: 0`, not the new appointment id. The server
  looks the booking up afterwards by date, time and doctor to return one.
- `Telefono` must be bare digits. A number with spaces or an area-code gap is
  rejected; strip everything that is not a digit.
- `ObtenerPrimerTurnoAsignableDeCadaRecursoDelServicioParaPortalWebConParticular`
  fails with a 500 unless `Prestaciones` holds a real procedure id.
- Availability calls need `IdEspecialidad` and answer 400 without it. Appointment
  rows do **not** carry it, so `find_earlier` looks it up by the doctor's name.
- `PrestacionMedica/...` accepts `0` as a wildcard specialty, which is how you
  list a doctor's procedures when you only know their service and branch.
- The portal enforces **one appointment per service per month** and refuses a
  second with "Ya tiene otro turno asignado para el mismo servicio en el mes".
  `ValidarAsignar` reports it, so `book_appointment(confirm=False)` surfaces it
  before anything is booked. Rules like this are why the dry run is worth making.

## API reference

Base: `https://miportal.sanatorioallende.com/backend`. Login is `POST /Token` with
`NumeroDocumento`, `Password` and `Sistema` base64-encoded; it returns
`{Access_token}`, which every other call sends as `Authorization: Bearer <jwt>`.
Everything below sits under `/backend/api/`.

| Method · Path | Purpose |
|---|---|
| `POST TurnosBuscadorGenerico/ObtenerEspecialidadServicioProfesionalPorCriterio` | free-text search → `{Especialidades, Profesionales}` |
| `GET Paciente/ObtenerPorId/{id}` | patient record: age, sex, email, phones, default cover |
| `GET Cobertura/ObtenerPorIdPaciente/{id}` | health covers → `IdMutual`, `IdPlanMutual` |
| `GET PrestacionMedica/ObtenerPorRecursoEspecialidadServicioSucursalParaPortalWeb/{tipoRecurso}/{recurso}/{especialidad}/{servicio}/{sucursal}` | procedures a doctor offers |
| `POST DisponibilidadDeTurnos/ObtenerPrimerTurnoAsignableDeCadaRecursoDelServicioParaPortalWebConParticular` | first free slot per doctor in a specialty |
| `POST DisponibilidadDeTurnos/ObtenerTurnosDisponiblesParaPortalConParticular` | full availability for one doctor |
| `POST turnos/ObtenerTurnosParaPortalPorFiltro` | the patient's appointments → `{Rows, Columns, RowCount}` |
| `POST turnos/ValidarAsignar` | validate a booking |
| `POST turnos/Asignar` | book |
| `POST turnos/CancelarTurno` | cancel → `{IdTurno, IdMotivoDeAnulacionTurno, Observaciones}` |

Dates inside a search criterion use `M-D-YYYY`. Slot dates come back ISO and go
back out as `YYYY-MM-DDT00:00:00`.

Booking and validation both take `{CriterioBusquedaDto, TurnoElegidoDto}` and
answer `{IsOk, Message, HasWarnings, WarningMessage, HasConfirmations,
ConfirmationMessage, IdEntidadValidada}`. `TurnoElegidoDto` is one slot from the
availability response, with `IdRecurso`, `IdFinanciador` and `IdPlan` filled in
from the resource block that contained it — the portal builds it the same way.

## Notes & etiquette

- **Reuse the token; don't hammer `/Token`** — repeated failed logins can lock the
  account. The server caches the token and only re-logs-in on a 401 (throttled).
- This is an **unofficial, personal** client built from the patient's own account.
- Booking and cancelling affect real hospital appointments and, indirectly, other
  patients waiting for the same slot. Keep the `confirm=True` step.
