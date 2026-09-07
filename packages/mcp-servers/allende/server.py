#!/usr/bin/env python3
"""
MCP Server — Sanatorio Allende patient portal.

Lets an assistant search for doctors, read appointment availability, book a
slot and cancel a booking, using the patient's own portal account. Same FastMCP
pattern as DeeDee's packages/mcp-servers/pilotfy/server.py.

API notes (read off the portal bundle and verified against the live API):
  - Host: https://miportal.sanatorioallende.com/backend
  - Auth: POST /Token with the fields base64-encoded ->  {Access_token: <jwt>}.
    Send it as  Authorization: Bearer <jwt>.  The JWT carries the patientId
    claim, so the patient never has to be configured by hand.
  - Everything else lives under /backend/api/.
  - Date parameters in search criteria use M-D-YYYY. Slot dates come back as
    ISO and go back out as YYYY-MM-DDT00:00:00.

Booking is a two-call flow, exactly as the portal does it:
    POST turnos/ValidarAsignar   -> {IsOk, Message, HasWarnings, WarningMessage,
                                     HasConfirmations, ConfirmationMessage}
    POST turnos/Asignar          -> same shape; IdEntidadValidada is the new id
Both take {CriterioBusquedaDto, TurnoElegidoDto}. When ValidarAsignar reports
HasConfirmations, the portal repeats the call with ConfirmarMensajes=true in the
criterion, which is what `confirm=True` does here.

Secrets are NEVER hardcoded or logged. They come from the environment:
  ALLENDE_USERNAME + ALLENDE_PASSWORD   (preferred — allows auto re-login on 401)
  ALLENDE_TOKEN                         (alternative — a raw JWT; can't self-refresh)
Optional: ALLENDE_BASE, ALLENDE_ID_PACIENTE, ALLENDE_ID_FINANCIADOR,
          ALLENDE_ID_PLAN, ALLENDE_ID_TIPO_DOCUMENTO, ALLENDE_ENV_FILE.
"""

import argparse
import base64
import binascii
import json
import os
import re
import sys
import threading
import time
import zlib
from datetime import date, datetime, timedelta, timezone

import requests  # type: ignore

# mcp 2.x renamed FastMCP to MCPServer. Both expose .tool() and .run(transport=...),
# so support either and let the installed version decide.
try:
    from mcp.server.fastmcp import FastMCP as _Server  # type: ignore
    _MCP_MAJOR = 1
except ModuleNotFoundError:
    from mcp.server.mcpserver import MCPServer as _Server  # type: ignore
    _MCP_MAJOR = 2


# ── Config ───────────────────────────────────────────────────────────────────
def _load_env_file():
    """Read the repo's .env into the environment without clobbering real vars.

    The checker in this repo already keeps credentials in ../.env, so reuse it
    when the MCP client does not pass them in.
    """
    path = os.environ.get("ALLENDE_ENV_FILE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env"
    )
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


_load_env_file()

BASE = os.environ.get("ALLENDE_BASE", "https://miportal.sanatorioallende.com/backend").rstrip("/")
API = BASE + "/api/"
USERNAME = os.environ.get("ALLENDE_USERNAME", "").strip()
PASSWORD = os.environ.get("ALLENDE_PASSWORD", "")
STATIC_TOKEN = os.environ.get("ALLENDE_TOKEN", "").strip()


def _opt_int(name):
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw.lstrip("-").isdigit() else None


ID_TIPO_DOCUMENTO = _opt_int("ALLENDE_ID_TIPO_DOCUMENTO") or 1
PATIENT_OVERRIDE = _opt_int("ALLENDE_ID_PACIENTE")
FINANCIER_OVERRIDE = _opt_int("ALLENDE_ID_FINANCIADOR")
PLAN_OVERRIDE = _opt_int("ALLENDE_ID_PLAN")

REQUEST_TIMEOUT = 60          # seconds per HTTP call
MIN_LOGIN_INTERVAL = 5.0      # seconds — guard against hammering /Token (lockout risk)
DEFAULT_WINDOW_DAYS = 90      # how far ahead availability searches look by default
MAX_DAYS_RETURNED = 15        # cap on days rendered by find_availability

# "CONSULTA" — the plain in-person visit. Most specialties use this id, but not
# all (traumatology and oncology have their own), so it is only a starting guess.
GENERIC_CONSULTA = 5495

# Portal constants, from the app bundle.
SEX_BY_ID = {4: "M", 5: "F"}          # Pl = {INDISTINTO:0, MASCULINO:4, FEMENINO:5}
TIPO_RECURSO_MEDICO = 1
ID_SISTEMA_CLIENTE = 2                # app-portal-paciente
ID_TIPO_BUSQUEDA = 1
ID_TIPO_DE_TURNO = 1

# Cancellation reasons the portal offers a patient, and the one it defaults to.
CANCEL_REASONS = {1: "Ya me atendí en otro lugar", 2: "La fecha es muy lejana",
                  4: "Otro motivo / prefiero no decirlo", 5: "Motivo médico"}
DEFAULT_CANCEL_REASON = 4    # SIN_RAZON

mcp = _Server("allende-server")


# ── Session state ────────────────────────────────────────────────────────────
class _State:
    def __init__(self):
        self.token = None
        self.token_source = None     # "env" | "login"
        self.last_login = 0.0
        self.logins = 0
        # resolved once via _boot()
        self.booted = False
        self.patient_id = None
        self.patient = {}
        self.age = None
        self.sex = ""
        self.email = ""
        self.phone = ""
        self.financier_id = None
        self.plan_id = None
        self.coverage_name = ""


_S = _State()
_LOCK = threading.RLock()   # guards _boot() + login/token mutation (FastMCP runs sync tools in threads)


class AllendeError(Exception):
    """Carries a user-facing message plus optional HTTP status / API payload."""

    def __init__(self, message, status=None, payload=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.payload = payload

    def as_dict(self):
        d = {"error": self.message}
        if self.status is not None:
            d["status"] = self.status
        if self.payload is not None:
            d["detail"] = self.payload
        return d


def _json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


def _fail(e):
    """Render any exception as a structured JSON error (tools never throw)."""
    if isinstance(e, AllendeError):
        return _json(e.as_dict())
    return _json({"error": f"{type(e).__name__}: {e}"})


# ── Auth + HTTP ──────────────────────────────────────────────────────────────
def _safe_json(resp):
    try:
        return resp.json()
    except Exception:
        txt = (resp.text or "").strip()
        return txt or None


def _b64(value):
    return base64.b64encode(str(value).encode()).decode()


def _do_login(force=False):
    """Exchange document number + password for a JWT. Throttled to avoid lockout.

    `force=True` bypasses the throttle for the single deliberate retry after a
    401 (bounded by `_retry=False`); the cold path stays throttled so repeated
    tool calls with bad credentials can't hammer /Token.
    """
    if not (USERNAME and PASSWORD):
        raise AllendeError("Login required but ALLENDE_USERNAME/ALLENDE_PASSWORD are not set.")
    with _LOCK:
        now = time.monotonic()
        if not force and _S.logins and (now - _S.last_login) < MIN_LOGIN_INTERVAL:
            raise AllendeError("Refusing to re-login so soon (account-lockout protection). Try again shortly.")
        _S.last_login = now
        _S.logins += 1
        body = {
            "NumeroDocumento": _b64(USERNAME),
            "Password": _b64(PASSWORD),
            "Sistema": _b64("app-portal-paciente"),
            "Grant_type": "password",
            "IdTipoDocumento": ID_TIPO_DOCUMENTO,
            "Id": 0,
            "ChangePassword": False,
            "IsAnonymous": False,
            "SolicitarReCaptcha": False,
        }
        try:
            r = requests.post(BASE + "/Token", json=body,
                              headers={"Content-Type": "application/json"},
                              timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            raise AllendeError(f"network error during login: {e}")
        data = _safe_json(r)
        if not r.ok:
            raise AllendeError(f"login failed: HTTP {r.status_code}", status=r.status_code,
                               payload=data if isinstance(data, (dict, list)) else None)
        tok = (data or {}).get("Access_token") if isinstance(data, dict) else None
        if not tok:
            raise AllendeError("login response contained no Access_token")
        _S.token = tok
        _S.token_source = "login"


def _token():
    with _LOCK:
        if not _S.token:
            if STATIC_TOKEN:
                _S.token = STATIC_TOKEN
                _S.token_source = "env"
            else:
                _do_login()
        return _S.token


def _api(method, path, body=None, _retry=True):
    """Authenticated request against /backend/api/. Returns parsed JSON."""
    tok = _token()
    try:
        r = requests.request(
            method, API + path.lstrip("/"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok},
            json=body, timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as e:
        raise AllendeError(f"network error calling {path}: {e}")

    # Token rejected — re-login once and retry (only possible with user+password).
    if r.status_code in (401, 403) and _retry and USERNAME and PASSWORD:
        _S.token = None
        _do_login(force=True)   # deliberate single retry; bounded by _retry=False below
        return _api(method, path, body, _retry=False)

    data = _safe_json(r)
    if not r.ok:
        msg = None
        if isinstance(data, dict):
            msg = data.get("Message") or data.get("message") or data.get("error")
        raise AllendeError(msg or f"HTTP {r.status_code} calling {path}", status=r.status_code,
                           payload=(data if not msg else None))
    return data if data is not None else {}


def _get(path):
    return _api("GET", path)


def _post(path, body):
    return _api("POST", path, body)


# ── Small helpers ────────────────────────────────────────────────────────────
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _jwt_claims(token):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8", "replace"))
    except (IndexError, ValueError, binascii.Error, UnicodeDecodeError):
        return {}


def _claim(claims, suffix):
    for k, v in claims.items():
        if k.rsplit("/", 1)[-1] == suffix:
            return v
    return None


def _fmt_epoch(epoch):
    try:
        return datetime.fromtimestamp(int(epoch), timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _api_date(d):
    """The search criteria want M-D-YYYY."""
    return f"{d.month}-{d.day}-{d.year}"


def _iso_day(value):
    """Normalise any date the API returns down to YYYY-MM-DD (portal normalizeDate)."""
    if not value:
        return ""
    s = str(value)
    if _DATE_RE.match(s):
        return s
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    return s


def _parse_day(value, field):
    s = _iso_day(value)
    if not _DATE_RE.match(s):
        raise AllendeError(f"{field} must be YYYY-MM-DD, got {value!r}")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise AllendeError(f"{field} is not a real date: {value!r}")


def _clean(value):
    return (str(value) if value is not None else "").strip()


def _pack(obj):
    """Encode a slot reference as a short, self-contained, opaque token."""
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode().rstrip("=")


def _unpack(ref):
    try:
        pad = ref + "=" * (-len(ref) % 4)
        return json.loads(zlib.decompress(base64.urlsafe_b64decode(pad)).decode())
    except Exception:
        raise AllendeError("slot_ref is not valid. Re-run find_availability and use a fresh one.")


# A slot_ref only stores what varies. The rest of the criterion is rebuilt from
# the patient's own details at booking time, which keeps the token short.
def _ref_criterion(crit, start, end, id_prestacion, id_tipo_recurso):
    return {"sv": crit.get("IdServicio"), "es": crit.get("IdEspecialidad"),
            "su": crit.get("IdSucursal"), "pr": id_prestacion, "tr": id_tipo_recurso,
            "fd": start.isoformat(), "ft": end.isoformat()}


def _criterion_from_ref(compact):
    """Rebuild the full CriterioBusquedaDto a slot_ref was created with."""
    if not isinstance(compact, dict):
        raise AllendeError("slot_ref is missing its search criterion. Re-run find_availability.")
    return _criterion(
        compact.get("sv"), compact.get("su"), compact.get("es"), None, compact.get("pr"),
        _parse_day(compact.get("fd"), "slot_ref.from"), _parse_day(compact.get("ft"), "slot_ref.to"),
        compact.get("tr") or TIPO_RECURSO_MEDICO,
    )


# ── Boot: resolve the patient and their coverage once ────────────────────────
def _boot():
    if _S.booted:
        return
    with _LOCK:
        if _S.booted:   # re-check after acquiring the lock (another thread may have booted)
            return

        pid = PATIENT_OVERRIDE
        if pid is None:
            raw = _claim(_jwt_claims(_token()), "patientId")
            if raw is not None and str(raw).isdigit():
                pid = int(raw)
        if pid is None:
            raise AllendeError("Could not determine the patient id. Set ALLENDE_ID_PACIENTE.")
        _S.patient_id = pid

        patient = _get(f"Paciente/ObtenerPorId/{pid}")
        if not isinstance(patient, dict):
            patient = {}
        _S.patient = patient
        _S.age = patient.get("Edad")
        _S.sex = SEX_BY_ID.get(patient.get("IdTipoSexo") or patient.get("IdSexo"), "")
        _S.email = _clean(patient.get("Email"))
        # The portal rejects anything but bare digits: a number written with a
        # space or an area-code gap fails validation, so strip to digits.
        for tel in patient.get("Telefonos") or []:
            if tel.get("Defecto") or not _S.phone:
                full = _clean(tel.get("TelefonoCompleto") or tel.get("Numero"))
                _S.phone = "".join(ch for ch in full if ch.isdigit())
                if tel.get("Defecto"):
                    break

        coverage = patient.get("CoberturaPorDefecto")
        if not isinstance(coverage, dict):
            coverages = _get(f"Cobertura/ObtenerPorIdPaciente/{pid}")
            actives = [c for c in (coverages or []) if isinstance(c, dict) and c.get("Activa")]
            coverage = actives[0] if actives else {}
        _S.financier_id = FINANCIER_OVERRIDE or coverage.get("IdMutual")
        _S.plan_id = PLAN_OVERRIDE or coverage.get("IdPlanMutual")
        _S.coverage_name = _clean(coverage.get("NombreCorto") or coverage.get("MutualNombre"))

        _S.booted = True


def _criterion(id_servicio, id_sucursal, id_especialidad, id_recurso, id_prestacion,
               date_from, date_to, id_tipo_recurso=TIPO_RECURSO_MEDICO):
    """The CriterioBusquedaDto every availability and booking call is built on."""
    crit = {
        "IdPaciente": _S.patient_id,
        "EdadPaciente": _S.age,
        "SexoPaciente": _S.sex,
        "IdFinanciador": _S.financier_id,
        "IdPlan": _S.plan_id,
        "IdSucursal": id_sucursal,
        "IdServicio": id_servicio,
        "IdEspecialidad": id_especialidad,
        "IdTipoRecurso": id_tipo_recurso,
        "IdTipoDeTurno": ID_TIPO_DE_TURNO,
        "IdTipoBusqueda": ID_TIPO_BUSQUEDA,
        "IdSistemaCliente": ID_SISTEMA_CLIENTE,
        "ControlarEdad": True,
        "FechaDesde": _api_date(date_from),
        "FechaHasta": _api_date(date_to),
    }
    if id_recurso:
        crit["IdRecurso"] = id_recurso
    if id_prestacion:
        crit["IdPrestacion"] = id_prestacion
        crit["Prestaciones"] = [{"IdPrestacion": id_prestacion, "IdItemSolicitudEstudios": 0}]
    return crit


def _default_procedure(id_recurso, id_especialidad, id_servicio, id_sucursal,
                       id_tipo_recurso=TIPO_RECURSO_MEDICO):
    """Pick the doctor's plain in-person consultation when none was given."""
    path = ("PrestacionMedica/ObtenerPorRecursoEspecialidadServicioSucursalParaPortalWeb/"
            f"{id_tipo_recurso}/{id_recurso}/{id_especialidad}/{id_servicio}/{id_sucursal}")
    items = [p for p in (_get(path) or []) if isinstance(p, dict) and p.get("Activo")]
    if not items:
        return None
    in_person = [p for p in items if not p.get("HabilitadaTelemedicina")]
    return (in_person or items)[0].get("Id")


def _window(date_from, date_to):
    start = _parse_day(date_from, "date_from") if date_from else date.today()
    end = _parse_day(date_to, "date_to") if date_to else start + timedelta(days=DEFAULT_WINDOW_DAYS)
    if end < start:
        raise AllendeError("date_to is before date_from")
    return start, end


def _enrich(slot, block, crit):
    """Flatten one TurnosAsignables entry into the shape the booking call needs.

    Mirrors the portal: fields missing on the slot fall back to the resource
    block that contains it, then to the search criterion.
    """
    return {
        "Fecha": _iso_day(slot.get("Fecha")),
        "Hora": slot.get("Hora") or "",
        "HoraFin": slot.get("HoraFin"),
        "IdRecurso": slot.get("IdRecurso") or block.get("IdRecurso") or crit.get("IdRecurso"),
        "IdTipoRecurso": block.get("IdTipoRecurso") or crit.get("IdTipoRecurso") or TIPO_RECURSO_MEDICO,
        "IdServicio": slot.get("IdServicio") or block.get("IdServicio") or crit.get("IdServicio"),
        "IdSucursal": slot.get("IdSucursal") or crit.get("IdSucursal") or 0,
        "Duracion": slot.get("Duracion") or slot.get("DuracionIndividual"),
        "IdPlantillaTurno": slot.get("IdPlantillaTurno"),
        "IdItemDePlantilla": slot.get("IdItemDePlantilla"),
        "Particular": slot.get("Particular"),
        "IdFinanciador": slot.get("IdFinanciador") or block.get("IdFinanciador"),
        "IdPlan": slot.get("IdPlan") or block.get("IdPlan"),
        "IdProfesionalAtiende": slot.get("IdProfesionalAtiende"),
        "NombreProfesionalAtiende": slot.get("NombreProfesionalAtiende"),
    }


def _assign_body(slot, crit, confirm_messages=False):
    """Build {CriterioBusquedaDto, TurnoElegidoDto} exactly as the portal does."""
    turno = {
        "Fecha": (slot["Fecha"] + "T00:00:00") if slot.get("Fecha") else slot.get("Fecha"),
        "Hora": slot.get("Hora"),
        "IdItemDePlantilla": slot.get("IdItemDePlantilla"),
        "IdPlantillaTurno": slot.get("IdPlantillaTurno"),
        "IdSucursal": slot.get("IdSucursal"),
        "DuracionIndividual": slot.get("Duracion"),
        "IdFinanciador": slot.get("IdFinanciador"),
        "IdPlan": slot.get("IdPlan"),
        "RequisitoAdministrativoAlOtorgar": None,
    }
    criterion = dict(crit)
    criterion["IdRecurso"] = slot.get("IdRecurso")
    criterion["IdTipoRecurso"] = slot.get("IdTipoRecurso") or crit.get("IdTipoRecurso") or TIPO_RECURSO_MEDICO
    criterion["IdSucursal"] = slot.get("IdSucursal") or crit.get("IdSucursal")
    if slot.get("Particular") and slot.get("IdFinanciador"):
        criterion["IdFinanciador"] = slot["IdFinanciador"]
        criterion["IdPlan"] = slot["IdPlan"]
    if confirm_messages:
        criterion["ConfirmarMensajes"] = True
    return {"CriterioBusquedaDto": criterion, "TurnoElegidoDto": turno}


def _result(resp):
    """Normalise the {IsOk, Message, HasWarnings, ...} envelope both calls return."""
    if not isinstance(resp, dict):
        return {"raw": resp}
    out = {
        "ok": bool(resp.get("IsOk")),
        "message": _clean(resp.get("Message")),
        "warning": _clean(resp.get("WarningMessage")) if resp.get("HasWarnings") else "",
        "confirmation": _clean(resp.get("ConfirmationMessage")) if resp.get("HasConfirmations") else "",
        "id": resp.get("IdEntidadValidada"),
    }
    return {k: v for k, v in out.items() if v not in ("", None)} or {"ok": out["ok"]}


def _specialty_for(id_recurso, id_servicio, id_sucursal, doctor_name):
    """Look a doctor's IdEspecialidad up by name — appointment rows do not carry it."""
    if not doctor_name:
        return None
    data = _post("TurnosBuscadorGenerico/ObtenerEspecialidadServicioProfesionalPorCriterio",
                 {"Criterio": doctor_name})
    hits = (data or {}).get("Profesionales") or [] if isinstance(data, dict) else []
    for want_branch in (True, False):
        for h in hits:
            if h.get("IdRecurso") != id_recurso or h.get("IdServicio") != id_servicio:
                continue
            if want_branch and h.get("IdSucursal") != id_sucursal:
                continue
            return h.get("IdEspecialidad")
    return None


def _find_booked(slot):
    """Find the id of the appointment just created, matching date, time and doctor."""
    try:
        day = _parse_day(slot.get("Fecha"), "slot date")
        data = _post("turnos/ObtenerTurnosParaPortalPorFiltro",
                     {"IdPaciente": _S.patient_id,
                      "FechaDesde": _api_date(day), "FechaHasta": _api_date(day),
                      "UsePagination": True, "PageSize": 200})
        matches = [r for r in ((data.get("Rows") or []) if isinstance(data, dict) else [])
                   if _clean(r.get("Hora")) == _clean(slot.get("Hora"))
                   and r.get("IdRecurso") == slot.get("IdRecurso")]
        # That day may also hold an older, cancelled booking at the same time.
        # Prefer a live one, then the newest id.
        live = [r for r in matches if _clean(r.get("Estado")).lower() == "asignado"]
        best = max(live or matches, key=lambda r: r.get("Id") or 0, default=None)
        return best.get("Id") if best else None
    except Exception:
        pass    # the booking succeeded; only the id lookup failed
    return None


# ── Tools ────────────────────────────────────────────────────────────────────
@mcp.tool()
def whoami() -> str:
    """Who the portal thinks I am: patient id, age, sex, contact, and my health cover.

    Every other tool uses these values automatically, so call this first if a
    booking is rejected for coverage or age reasons.
    """
    try:
        _boot()
        return _json({
            "patientId": _S.patient_id,
            "name": f"{_clean(_S.patient.get('Nombre'))} {_clean(_S.patient.get('Apellido'))}".strip(),
            "age": _S.age,
            "sex": _S.sex or "unknown",
            "birthDate": _iso_day(_S.patient.get("FechaNacimiento")),
            "email": _S.email,
            "phone": _S.phone,
            "coverage": {"name": _S.coverage_name, "financierId": _S.financier_id, "planId": _S.plan_id},
            "auth": {"source": _S.token_source, "expires": _fmt_epoch(_jwt_claims(_token()).get("exp"))},
            "host": BASE,
        })
    except Exception as e:
        return _fail(e)


@mcp.tool()
def search_doctors(query: str) -> str:
    """Find a specialty or a doctor by free text. Start here — it returns every id.

    Args:
        query: part of a doctor's surname, a specialty, or a service
               (for example "dermatolog", "cardio", or a surname).

    Returns two lists. `specialties` gives IdServicio/IdEspecialidad/IdSucursal —
    feed those to earliest_by_specialty. `doctors` adds IdRecurso — feed those to
    find_availability. The same doctor appears once per branch (Sucursal).
    """
    try:
        _boot()
        q = _clean(query)
        if len(q) < 3:
            raise AllendeError("query needs at least 3 characters")
        data = _post("TurnosBuscadorGenerico/ObtenerEspecialidadServicioProfesionalPorCriterio",
                     {"Criterio": q})
        if not isinstance(data, dict):
            data = {}
        specialties = [{
            "IdServicio": s.get("IdServicio"), "servicio": _clean(s.get("Servicio")),
            "IdEspecialidad": s.get("IdEspecialidad"), "especialidad": _clean(s.get("Especialidad")),
            "IdSucursal": s.get("IdSucursal"), "sucursal": _clean(s.get("Sucursal")),
        } for s in (data.get("Especialidades") or [])]
        doctors = [{
            "IdRecurso": d.get("IdRecurso"), "nombre": _clean(d.get("Nombre")),
            "IdTipoRecurso": d.get("IdTipoRecurso") or TIPO_RECURSO_MEDICO,
            "IdServicio": d.get("IdServicio"), "servicio": _clean(d.get("Servicio")),
            "IdEspecialidad": d.get("IdEspecialidad"), "especialidad": _clean(d.get("Especialidad")),
            "IdSucursal": d.get("IdSucursal"), "sucursal": _clean(d.get("Sucursal")),
        } for d in (data.get("Profesionales") or [])]
        return _json({"query": q, "specialties": specialties, "doctors": doctors,
                      "counts": {"specialties": len(specialties), "doctors": len(doctors)}})
    except Exception as e:
        return _fail(e)


@mcp.tool()
def list_procedures(idRecurso: int, idEspecialidad: int, idServicio: int, idSucursal: int,
                    idTipoRecurso: int = TIPO_RECURSO_MEDICO) -> str:
    """List what a doctor can be booked for — usually CONSULTA and CONSULTA TELEMEDICINA.

    Args: the four ids from search_doctors, plus IdTipoRecurso (1 = doctor).

    You rarely need this. find_availability and book_appointment default to the
    plain in-person consultation. Use it to book telemedicine instead.
    """
    try:
        _boot()
        path = ("PrestacionMedica/ObtenerPorRecursoEspecialidadServicioSucursalParaPortalWeb/"
                f"{idTipoRecurso}/{idRecurso}/{idEspecialidad}/{idServicio}/{idSucursal}")
        items = _get(path) or []
        return _json([{
            "IdPrestacion": p.get("Id"), "nombre": _clean(p.get("Nombre")),
            "telemedicina": bool(p.get("HabilitadaTelemedicina")),
            "activo": bool(p.get("Activo")),
            "requiereConsentimiento": bool(p.get("RequiereConsentimiento")),
        } for p in items if isinstance(p, dict)])
    except Exception as e:
        return _fail(e)


@mcp.tool()
def earliest_by_specialty(idServicio: int, idEspecialidad: int, idSucursal: int,
                          days: int = DEFAULT_WINDOW_DAYS, idPrestacion: int = 0) -> str:
    """The first free slot for EVERY doctor in a specialty — the fastest way to compare.

    Args:
        idServicio, idEspecialidad, idSucursal: from search_doctors.
        days: how far ahead to look (default 90).
        idPrestacion: what the visit is for. Defaults to the usual CONSULTA,
                      which most specialties use. A few (traumatology,
                      oncology) have their own — if this call fails, get the
                      right id from list_procedures and pass it here.

    Use this to answer "who can see me soonest?". Then call find_availability on
    the doctor you pick to get bookable slots.
    """
    try:
        _boot()
        start = date.today()
        end = start + timedelta(days=max(1, days))
        prestacion = idPrestacion or GENERIC_CONSULTA
        crit = _criterion(idServicio, idSucursal, idEspecialidad, None, prestacion, start, end)
        try:
            data = _post("DisponibilidadDeTurnos/"
                         "ObtenerPrimerTurnoAsignableDeCadaRecursoDelServicioParaPortalWebConParticular",
                         crit)
        except AllendeError as e:
            if idPrestacion:
                raise
            raise AllendeError(
                f"The portal rejected this search with the default procedure id "
                f"{GENERIC_CONSULTA} ({e.message}). This specialty likely uses a different "
                "one: pick any of its doctors with search_doctors, call list_procedures, "
                "then retry with idPrestacion set.", status=e.status)
        if not isinstance(data, dict):
            data = {}
        rows = []
        for r in (data.get("PrimerosTurnosDeCadaRecurso") or []):
            if not isinstance(r, dict):
                continue
            # Doctors with nothing free come back with a placeholder date.
            first_date = _iso_day(r.get("Fecha"))
            if first_date.startswith("0001"):
                first_date = ""
            rows.append({
                "IdRecurso": r.get("IdRecurso"), "doctor": _clean(r.get("Recurso")),
                "IdServicio": r.get("IdServicio") or idServicio,
                "servicio": _clean(r.get("Servicio")),
                "IdSucursal": r.get("IdSucursal") or idSucursal,
                "sucursal": _clean(r.get("Sucursal")),
                "IdEspecialidad": idEspecialidad,
                "firstDate": first_date or None,
                "firstTime": _clean(r.get("Hora")) or None,
                "hasAvailability": bool(first_date),
            })
        # Soonest first; doctors with nothing free go last.
        rows.sort(key=lambda x: (x["firstDate"] or "9999-99-99", x["firstTime"] or ""))
        out = {
            "searchedUntil": end.isoformat(),
            "idPrestacion": prestacion,
            "doctors": rows,
            "messages": data.get("MensajesValidacion") or [],
        }
        if not idPrestacion and not any(r["hasAvailability"] for r in rows):
            out["hint"] = (f"No doctor had a free slot for procedure id {prestacion}. That is the "
                           "usual CONSULTA, but some specialties use a different one. Find a doctor in "
                           "this specialty with search_doctors, call list_procedures on them, "
                           "then retry with idPrestacion.")
        return _json(out)
    except Exception as e:
        return _fail(e)


@mcp.tool()
def find_availability(idRecurso: int, idServicio: int, idEspecialidad: int, idSucursal: int,
                      dateFrom: str = "", dateTo: str = "", idPrestacion: int = 0,
                      maxDays: int = MAX_DAYS_RETURNED, doctorName: str = "") -> str:
    """Bookable slots for one doctor. Each slot carries the slot_ref that books it.

    Args:
        idRecurso, idServicio, idEspecialidad, idSucursal: from search_doctors.
        dateFrom: YYYY-MM-DD, defaults to today.
        dateTo:   YYYY-MM-DD, defaults to 90 days after dateFrom.
        idPrestacion: what the visit is for. Defaults to the plain in-person
                      consultation (see list_procedures).
        maxDays: how many days of slots to return (default 15).
        doctorName: the doctor's name from search_doctors. Optional, but pass it —
                    it is carried into the booking confirmation the user reads.

    Pass a slot's `slot_ref` straight to book_appointment. Refs go stale as other
    patients book, so fetch them fresh rather than reusing old ones.
    """
    try:
        _boot()
        start, end = _window(dateFrom, dateTo)
        prestacion = idPrestacion or _default_procedure(idRecurso, idEspecialidad, idServicio, idSucursal)
        if not prestacion:
            raise AllendeError(
                "This doctor has no bookable procedure for that specialty, service and "
                "branch. Check the ids with search_doctors, or pass idPrestacion yourself.")
        crit = _criterion(idServicio, idSucursal, idEspecialidad, idRecurso, prestacion, start, end)
        doctor_name = _clean(doctorName)[:60]
        ref_crit = _ref_criterion(crit, start, end, prestacion, TIPO_RECURSO_MEDICO)
        if doctor_name:
            ref_crit["dn"] = doctor_name
        blocks = _post("DisponibilidadDeTurnos/ObtenerTurnosDisponiblesParaPortalConParticular",
                       {"CriterioBusquedaDto": crit,
                        "FechaDesde": _api_date(start), "FechaHasta": _api_date(end)})
        if not isinstance(blocks, list):
            blocks = []

        by_day, messages, total = {}, [], 0
        for block in blocks:
            if not isinstance(block, dict):
                continue
            messages.extend(block.get("MensajesValidacion") or [])
            for day in (block.get("SituacionesPorDia") or []):
                for raw in (day.get("TurnosAsignables") or []):
                    if not raw.get("Hora"):
                        continue
                    slot = _enrich(raw, block, crit)
                    slot["Fecha"] = slot["Fecha"] or _iso_day(day.get("Fecha"))
                    if not slot["Fecha"]:
                        continue
                    total += 1
                    # The same clock time can appear more than once (one entry
                    # per template item). Keep one — a patient can only take one.
                    slots_today = by_day.setdefault(slot["Fecha"], {})
                    slots_today.setdefault(slot["Hora"], slot)

        days = []
        for d in sorted(by_day)[:max(1, maxDays)]:
            slots = sorted(by_day[d].values(), key=lambda s: s["Hora"])
            days.append({
                "date": d,
                "slots": [{"time": s["Hora"], "minutes": s.get("Duracion"),
                           "slot_ref": _pack({"s": s, "c": ref_crit})} for s in slots],
            })

        return _json({
            "doctor": {"IdRecurso": idRecurso, "name": doctor_name, "IdServicio": idServicio,
                       "IdEspecialidad": idEspecialidad, "IdSucursal": idSucursal},
            "idPrestacion": prestacion,
            "searched": {"from": start.isoformat(), "to": end.isoformat()},
            "slotsFound": total,
            "uniqueTimes": sum(len(v) for v in by_day.values()),
            "daysShown": len(days),
            "daysAvailable": len(by_day),
            "days": days,
            "messages": messages,
        })
    except Exception as e:
        return _fail(e)


@mcp.tool()
def find_earlier(appointmentId: int, maxDays: int = MAX_DAYS_RETURNED,
                 idPrestacion: int = 0, idEspecialidad: int = 0) -> str:
    """Free slots EARLIER than an appointment I already hold, with the same doctor.

    Args:
        appointmentId: the `Id` from my_appointments.
        maxDays: how many days of slots to return (default 15).
        idPrestacion: what the visit is for. Defaults to the one the doctor offers.
        idEspecialidad: normally worked out from the doctor's name; pass it only
                        if that lookup fails.

    This is the "can I be seen sooner?" tool. Returns the same slots and
    `slot_ref`s as find_availability, limited to before the appointment you hold.

    To move an appointment: book the earlier slot FIRST, check it succeeded, then
    cancel the old one. Cancelling first risks losing both, because anyone can
    take the earlier slot in between.
    """
    try:
        _boot()
        current = None
        for a in json.loads(my_appointments(includePast=False)).get("appointments", []):
            if a.get("Id") == appointmentId:
                current = a
                break
        if current is None:
            raise AllendeError(f"No upcoming appointment with id {appointmentId}. "
                               "Check my_appointments.")

        appt_day = _parse_day(current.get("date"), "appointment date")
        today = date.today()
        if appt_day <= today:
            return _json({"status": "no_earlier_possible", "current": current,
                          "note": "That appointment is today or already past."})

        specialty = idEspecialidad or _specialty_for(
            current.get("IdRecurso"), current.get("IdServicio"),
            current.get("IdSucursal"), current.get("doctor"))
        if not specialty:
            raise AllendeError(
                f"Could not work out the specialty for {current.get('doctor')}. "
                "Find them with search_doctors and pass idEspecialidad.")

        found = json.loads(find_availability(
            current.get("IdRecurso"), current.get("IdServicio"), specialty,
            current.get("IdSucursal"), dateFrom=today.isoformat(),
            dateTo=(appt_day - timedelta(days=1)).isoformat(),
            idPrestacion=idPrestacion, maxDays=maxDays,
            doctorName=current.get("doctor", "")))
        if "error" in found:
            return _json(found)

        found["current"] = current
        found["status"] = "earlier_found" if found.get("daysAvailable") else "nothing_earlier"
        found["note"] = ("Book the earlier slot first, confirm it worked, then cancel "
                         f"appointment #{appointmentId}. Cancelling first risks losing both.")
        return _json(found)
    except Exception as e:
        return _fail(e)


@mcp.tool()
def my_appointments(includePast: bool = False, sinceDate: str = "", untilDate: str = "",
                    limit: int = 200) -> str:
    """My booked appointments at the Sanatorio.

    Args:
        includePast: also list appointments that have already happened.
        sinceDate: YYYY-MM-DD lower bound. Defaults to today, or a year back
                   when includePast is true.
        untilDate: YYYY-MM-DD upper bound. Defaults to two years ahead.
        limit: how many rows to ask for (default 200).

    The `Id` on each row is what cancel_appointment takes.
    """
    try:
        _boot()
        today = date.today()
        if sinceDate:
            start = _parse_day(sinceDate, "sinceDate")
        else:
            start = today - timedelta(days=365) if includePast else today
        end = _parse_day(untilDate, "untilDate") if untilDate else today + timedelta(days=730)
        if end < start:
            raise AllendeError("untilDate is before sinceDate")
        # Two portal quirks. FechaHasta is not optional: without it the answer is
        # an empty list however wide the other filters are. And without PageSize
        # the answer is silently capped at 10 rows, oldest first.
        body = {"IdPaciente": _S.patient_id,
                "FechaDesde": _api_date(start), "FechaHasta": _api_date(end),
                "UsePagination": True, "PageSize": max(1, limit)}
        data = _post("turnos/ObtenerTurnosParaPortalPorFiltro", body)
        total = data.get("RowCount") if isinstance(data, dict) else None
        rows = data.get("Rows") if isinstance(data, dict) else None
        rows = rows if isinstance(rows, list) else []
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            out.append({k: v for k, v in {
                "Id": r.get("Id"), "date": _iso_day(r.get("Fecha")), "time": _clean(r.get("Hora")),
                "estado": _clean(r.get("Estado")), "doctor": _clean(r.get("Recurso")),
                "IdRecurso": r.get("IdRecurso"),
                "servicio": _clean(r.get("Servicio")), "IdServicio": r.get("IdServicio"),
                "sucursal": _clean(r.get("Sucursal")), "IdSucursal": r.get("IdSucursal"),
                "prestacion": _clean(r.get("PrestacionesConcatenadas") or r.get("Prestacion")),
                "tipo": _clean(r.get("TipoDeTurno")),
            }.items() if v not in ("", None)})
        out.sort(key=lambda x: (x.get("date") or "", x.get("time") or ""))
        result = {"from": start.isoformat(), "to": end.isoformat(),
                  "includePast": includePast, "count": len(out), "appointments": out}
        if isinstance(total, int) and total > len(out):
            result["truncated"] = f"{total} match the filter; raise limit to see them all."
        return _json(result)
    except Exception as e:
        return _fail(e)


@mcp.tool()
def book_appointment(slot_ref: str, observaciones: str = "", confirm: bool = False) -> str:
    """Book a slot. REAL appointment at a real hospital.

    Args:
        slot_ref: from find_availability. Fetch a fresh one; slots get taken.
        observaciones: optional note for the clinic.
        confirm: MUST be True to actually book. When False (default) this only
                 runs the portal's own validation and returns what it said —
                 nothing is booked.

    Always show the returned summary and any warning to the user, get an explicit
    OK, then call again with confirm=True. If the portal asks a question
    (`confirmation`), booking with confirm=True answers yes to it.
    """
    try:
        _boot()
        data = _unpack(slot_ref)
        slot = data.get("s") or {}
        if not slot.get("Fecha") or not slot.get("Hora"):
            raise AllendeError("slot_ref does not describe a slot. Re-run find_availability.")
        crit = _criterion_from_ref(data.get("c"))

        who = _clean((data.get("c") or {}).get("dn")) or f"doctor id {slot.get('IdRecurso')}"
        summary = (f"Book {slot['Fecha']} at {slot['Hora']} "
                   f"({slot.get('Duracion') or '?'} min) with {who}, "
                   f"branch id {slot.get('IdSucursal')}, for "
                   f"{_clean(_S.patient.get('Nombre'))} {_clean(_S.patient.get('Apellido'))} "
                   f"(patient {_S.patient_id}).")

        body = _assign_body(slot, crit, confirm_messages=confirm)
        if observaciones:
            body["Observaciones"] = observaciones
        if _S.email:
            body["Email"] = _S.email
        if _S.phone:
            body["Telefono"] = _S.phone

        check = _result(_post("turnos/ValidarAsignar", body))
        if not check.get("ok"):
            return _json({"status": "rejected", "summary": summary, "portal": check})

        if not confirm:
            return _json({
                "status": "needs_confirmation",
                "summary": summary,
                "portal": check,
                "note": "The portal accepted this slot but nothing is booked. "
                        "Show this to the user, then call book_appointment again with confirm=True.",
            })

        booked = _result(_post("turnos/Asignar", body))
        if not booked.get("ok"):
            return _json({"status": "failed", "summary": summary, "portal": booked})
        # Asignar answers with IdEntidadValidada 0, so look the new booking up by
        # date, time and doctor to hand back an id cancel_appointment can use.
        return _json({"status": "booked", "summary": summary,
                      "appointmentId": _find_booked(slot), "portal": booked})
    except Exception as e:
        return _fail(e)


@mcp.tool()
def cancel_appointment(appointmentId: int, reasonId: int = DEFAULT_CANCEL_REASON,
                       observaciones: str = "", confirm: bool = False) -> str:
    """Cancel one of my appointments. REAL action.

    Args:
        appointmentId: the `Id` from my_appointments.
        reasonId: why. 1 already seen elsewhere · 2 the date is too far off ·
                  4 other / rather not say (default) · 5 medical reason.
        observaciones: optional free text for the clinic.
        confirm: MUST be True to actually cancel. When False (default) this only
                 looks the appointment up and returns it for approval.

    Show the summary to the user and get their OK before calling again with
    confirm=True. Cancelling is final — rebooking means taking a new slot, which
    someone else may have taken by then.
    """
    try:
        _boot()
        if reasonId not in CANCEL_REASONS:
            raise AllendeError(f"reasonId {reasonId} is not valid; "
                               f"choose one of {sorted(CANCEL_REASONS)}")

        found = None
        listing = json.loads(my_appointments(includePast=True))
        for a in listing.get("appointments", []):
            if a.get("Id") == appointmentId:
                found = a
                break

        if found:
            summary = (f"Cancel appointment #{appointmentId} on {found.get('date')} "
                       f"at {found.get('time')} with {found.get('doctor')} "
                       f"({found.get('servicio')}, {found.get('sucursal')}). "
                       f"Reason: {CANCEL_REASONS[reasonId]}.")
        else:
            summary = (f"Cancel appointment #{appointmentId}. It is not among your listed "
                       "appointments — it may already be cancelled, or not yours. The portal "
                       "will reject it if you cannot cancel it. "
                       f"Reason: {CANCEL_REASONS[reasonId]}.")

        if not confirm:
            return _json({
                "status": "needs_confirmation",
                "summary": summary,
                "appointment": found,
                "reasons": [{"id": k, "label": v} for k, v in sorted(CANCEL_REASONS.items())],
                "note": "Nothing was cancelled. Show this to the user, then call "
                        "cancel_appointment again with confirm=True.",
            })

        body = {"IdTurno": appointmentId, "IdMotivoDeAnulacionTurno": reasonId}
        if observaciones:
            body["Observaciones"] = observaciones
        result = _result(_post("turnos/CancelarTurno", body))
        return _json({"status": "cancelled" if result.get("ok") else "failed",
                      "summary": summary, "portal": result})
    except Exception as e:
        return _fail(e)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Sanatorio Allende MCP Server")
    transports = ["stdio", "sse"] + (["streamable-http"] if _MCP_MAJOR >= 2 else [])
    parser.add_argument("--transport", choices=transports, default="stdio",
                        help="Transport method (default stdio)")
    args = parser.parse_args()

    if USERNAME and PASSWORD:
        mode = "user/password"
    elif STATIC_TOKEN:
        mode = "token"
    else:
        mode = "NONE"
    # Log to stderr only — stdout is the MCP protocol channel under stdio.
    print(f"Starting Allende MCP Server ({args.transport}; mcp v{_MCP_MAJOR}; auth={mode}; host={BASE})...",
          file=sys.stderr)
    if mode == "NONE":
        print("WARNING: no credentials. Set ALLENDE_USERNAME+ALLENDE_PASSWORD or ALLENDE_TOKEN.",
              file=sys.stderr)

    mcp.run(transport=args.transport)
