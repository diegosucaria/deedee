#!/usr/bin/env python3
"""
MCP Server — Pilotfy integration for DeeDee.

Lets the assistant view aircraft availability and make/cancel bookings at a
flight school served by Pilotfy's legacy "school-turns" API (e.g. Aero Club
Córdoba, schoolId 34). Uses the same FastMCP pattern as
packages/plex-mcp-server/ and packages/mcp-servers/browser-use/.

API notes (verified live; full trail at github.com/diegosucaria/pilotfy-calendar):
  - Host: https://api.pilotfy.com.ar
  - Auth: POST /api/v3/user/signin {email,password} -> {data:{token,user}}.
    Send the token on every request as header  Authorization: <token>
    (raw JWT, NO "Bearer"). ~30-day expiry.
  - Every response is wrapped in {data: ...}.

Secrets are NEVER hardcoded or logged. They come from the environment:
  PILOTFY_EMAIL + PILOTFY_PASSWORD   (preferred — allows auto re-login on 401)
  PILOTFY_TOKEN                      (alternative — a raw JWT; can't self-refresh)
Optional: PILOTFY_BASE, PILOTFY_SCHOOL_ID, PILOTFY_TZ_OFFSET.
"""

import argparse
import base64
import json
import math
import os
import re
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone

import requests  # type: ignore
from mcp.server.fastmcp import FastMCP  # type: ignore

# ── Configuration (from env — never hardcode secrets) ────────────────────────
BASE = os.environ.get("PILOTFY_BASE", "https://api.pilotfy.com.ar").rstrip("/")
EMAIL = os.environ.get("PILOTFY_EMAIL", "").strip()
PASSWORD = os.environ.get("PILOTFY_PASSWORD", "")
STATIC_TOKEN = os.environ.get("PILOTFY_TOKEN", "").strip()
_sid_raw = os.environ.get("PILOTFY_SCHOOL_ID", "").strip()
SCHOOL_ID_OVERRIDE = int(_sid_raw) if _sid_raw.isdigit() else None
try:
    TZ = float(os.environ.get("PILOTFY_TZ_OFFSET", "-3"))  # Argentina = -3
except ValueError:
    TZ = -3.0

REQUEST_TIMEOUT = 30          # seconds per HTTP call
MIN_SIGNIN_INTERVAL = 5.0     # seconds — guard against hammering signin (lockout risk)

# ── Reference data (from the Pilotfy app) ────────────────────────────────────
STATUS = {1: "Pendiente", 2: "Aprobado", 3: "Cancelado por piloto",
          4: "Cancelado por escuela", 5: "Cancelado por instructor"}
REASON = {1: "Vuelo Privado", 2: "Instrucción Alumno", 3: "Readaptación",
          4: "Navegación", 5: "Bautismo", 6: "Adaptación", 7: "Vuelo No Regular",
          8: "Prueba de Aeronaves", 9: "Trabajo Aéreo", 10: "Examen"}
OCCUPYING = {1, 2}            # only Pendiente/Aprobado occupy an aircraft; 3/4/5 = free
INSTRUCTOR_REQUIRED = {2, 3}  # Instrucción Alumno, Readaptación — a solo flight is rejected

mcp = FastMCP("pilotfy-server")


# ── Session state ────────────────────────────────────────────────────────────
class _State:
    def __init__(self):
        self.token = None
        self.token_source = None     # "env" | "signin"
        self.user = None
        self.last_signin = 0.0
        self.signins = 0
        # resolved once via _boot()
        self.booted = False
        self.school_id = None
        self.school = {}
        self.turns_from = "06:00"
        self.turns_to = "21:00"
        self.weeks = 2
        self.max_turns = None
        self.aerodrome = {"lat": -31.4868, "lng": -64.1408, "name": "Córdoba (fallback)"}


_S = _State()
_LOCK = threading.RLock()   # guards _boot() + login/token mutation (FastMCP runs sync tools in threads)


class PilotfyError(Exception):
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


def _fail(e):
    """Render any exception as a structured JSON error (tools never throw)."""
    if isinstance(e, PilotfyError):
        return _json(e.as_dict())
    return _json({"error": str(e)})


def _json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


# ── Auth + HTTP ──────────────────────────────────────────────────────────────
def _safe_json(resp):
    try:
        return resp.json()
    except Exception:
        txt = (resp.text or "").strip()
        return txt or None


def _do_signin(force=False):
    """Exchange email+password for a token. Throttled to avoid account lockout.
    `force=True` bypasses the throttle for the single deliberate retry after a 401
    (which is bounded by `_retry=False`); the cold path stays throttled so repeated
    tool calls with bad credentials can't hammer signin."""
    if not (EMAIL and PASSWORD):
        raise PilotfyError("Login required but PILOTFY_EMAIL/PILOTFY_PASSWORD are not set.")
    with _LOCK:
        now = time.monotonic()
        if not force and _S.signins and (now - _S.last_signin) < MIN_SIGNIN_INTERVAL:
            raise PilotfyError("Refusing to re-login so soon (account-lockout protection). Try again shortly.")
        _S.last_signin = now
        _S.signins += 1
        try:
            r = requests.post(
                BASE + "/api/v3/user/signin",
                json={"email": EMAIL, "password": PASSWORD},
                headers={"Content-Type": "application/json"},
                timeout=REQUEST_TIMEOUT,
            )
        except requests.RequestException as e:
            raise PilotfyError(f"network error during signin: {e}")
        data = _safe_json(r)
        if not r.ok:
            err = data.get("error") if isinstance(data, dict) else None
            raise PilotfyError(f"login failed: {err or ('HTTP ' + str(r.status_code))}", status=r.status_code)
        tok = ((data or {}).get("data") or {}).get("token")
        if not tok:
            raise PilotfyError("login response contained no token")
        _S.token = tok
        _S.token_source = "signin"
        _S.user = ((data or {}).get("data") or {}).get("user")


def _token():
    with _LOCK:
        if not _S.token:
            if STATIC_TOKEN:
                _S.token = STATIC_TOKEN
                _S.token_source = "env"
            else:
                _do_signin()
        return _S.token


def _api(method, path, body=None, _retry=True):
    """Authenticated request. Returns parsed JSON (dict/list); raises PilotfyError."""
    tok = _token()
    try:
        r = requests.request(
            method, BASE + path,
            headers={"Content-Type": "application/json", "Authorization": tok},
            json=body, timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as e:
        raise PilotfyError(f"network error calling {path}: {e}")

    # Token rejected — re-login once and retry (only possible with email+password).
    if r.status_code in (401, 403) and _retry and EMAIL and PASSWORD:
        _S.token = None
        _do_signin(force=True)   # deliberate single retry; bounded by _retry=False below
        return _api(method, path, body, _retry=False)

    data = _safe_json(r)
    if not r.ok:
        err = data.get("error") if isinstance(data, dict) else None
        raise PilotfyError(err or f"HTTP {r.status_code}", status=r.status_code,
                           payload=(data if not err else None))
    return data if data is not None else {}


def _get(path):
    """GET and unwrap the {data: ...} envelope."""
    resp = _api("GET", path)
    if isinstance(resp, dict) and "data" in resp:
        return resp["data"]
    return resp


def _boot():
    """Resolve school + aerodrome once (auto-detect first active membership)."""
    if _S.booted:
        return
    with _LOCK:
        if _S.booted:   # re-check after acquiring the lock (another thread may have booted)
            return
        memberships = _get("/api/v3/school/user") or []
        active = [m for m in memberships if m.get("status") == 1 and m.get("school")]

        school = None
        school_id = None
        if SCHOOL_ID_OVERRIDE is not None:
            school_id = SCHOOL_ID_OVERRIDE
            match = next((m for m in active if m.get("schoolId") == school_id), None)
            if match:
                school = match["school"]
        if school is None and not school_id:
            if not active:
                raise PilotfyError("You don't belong to any active school in Pilotfy.")
            chosen = active[0]
            school_id = chosen["schoolId"]
            school = chosen["school"]

        # Fall back to the school-detail endpoint (also the source of aerodrome coords).
        detail = None
        try:
            detail = _get(f"/api/v3/school/id/{school_id}")
        except PilotfyError:
            detail = None
        if school is None:
            school = detail or {}

        _S.school_id = school_id
        _S.school = school or {}
        _S.turns_from = school.get("turnsFrom") or "06:00"
        _S.turns_to = school.get("turnsTo") or "21:00"
        _S.weeks = school.get("turnWeeks") or 2
        _S.max_turns = school.get("turnsMaxByUser")

        aero = (detail or {}).get("aerodrome") if isinstance(detail, dict) else None
        if aero and aero.get("latitude") is not None:
            _S.aerodrome = {"lat": aero["latitude"], "lng": aero.get("longitude"),
                            "name": aero.get("name")}
        _S.booted = True


# ── Small helpers ─────────────────────────────────────────────────────────────
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")


def _min(hhmm):
    h, m = (hhmm or "0:0").split(":")[:2]
    return int(h) * 60 + int(m)


def _hhmm(m):
    if m is None:
        return None
    m = int(round(m))
    return f"{m // 60:02d}:{m % 60:02d}"


def _dur(mins):
    h, m = divmod(int(mins), 60)
    if h and m:
        return f"{h}h{m:02d}"
    if h:
        return f"{h}h"
    return f"{m}min"


def _validate_date(s):
    if not _DATE_RE.match(s or ""):
        raise PilotfyError(f"date must be YYYY-MM-DD, got '{s}'")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise PilotfyError(f"invalid calendar date '{s}'")


def _validate_time(s):
    if not _TIME_RE.match(s or ""):
        raise PilotfyError(f"time must be HH:mm, got '{s}'")
    h, m = (int(x) for x in s.split(":"))
    if h > 23 or m > 59:
        raise PilotfyError(f"invalid time '{s}'")


def _overlaps(a1, a2, b1, b2):
    return a1 < b2 and b1 < a2


def _instr_label(t):
    ins = t.get("instructor") or {}
    if ins.get("name"):
        return ins["name"]
    if t.get("withoutInstructor"):
        return "Sin instructor"
    if t.get("anyInstructor"):
        return "Cualquiera"
    return None


def _reason_name(code):
    return REASON.get(code, f"reason {code}")


def _status_name(code):
    return STATUS.get(code, f"status {code}")


def _jwt_exp(token):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("exp")
    except Exception:
        return None


def _fmt_epoch(epoch):
    try:
        return datetime.fromtimestamp(int(epoch)).strftime("%Y-%m-%d")
    except Exception:
        return "unknown"


def _today():
    """Today's date in the aerodrome's timezone (not the server's local clock),
    so the 'past' check and the booking window line up with the aeroclub's day."""
    return datetime.now(timezone(timedelta(hours=TZ))).date()


def _free_gaps(busy_intervals, start_min, end_min):
    """Complement of busy intervals within [start_min, end_min]."""
    gaps = []
    cursor = start_min
    for f, t in sorted(busy_intervals):
        f = max(f, start_min)
        t = min(t, end_min)
        if t <= cursor:
            continue
        if f > cursor:
            gaps.append((cursor, f))
        cursor = max(cursor, t)
    if cursor < end_min:
        gaps.append((cursor, end_min))
    return gaps


def sun_times(date_str, lat, lng, tz=-3):
    """Sunrise/sunset + civil twilight via the classic almanac algorithm
    (zenith 90.833° for sun, 96° for civil twilight). Ported verbatim from the
    pilotfy-calendar app. Returns minutes-from-local-midnight (or None if the
    sun doesn't cross). tz in hours."""
    rad = math.pi / 180
    deg = 180 / math.pi
    Y, Mo, Da = (int(x) for x in date_str.split("-"))
    N = (math.floor(275 * Mo / 9)
         - math.floor((Mo + 9) / 12) * (1 + math.floor((Y - 4 * math.floor(Y / 4) + 2) / 3))
         + Da - 30)

    def ev(zenith, rising):
        lng_hour = lng / 15
        t = N + ((6 - lng_hour) / 24) if rising else N + ((18 - lng_hour) / 24)
        M = (0.9856 * t) - 3.289
        L = M + (1.916 * math.sin(rad * M)) + (0.020 * math.sin(rad * 2 * M)) + 282.634
        L = ((L % 360) + 360) % 360
        RA = deg * math.atan(0.91764 * math.tan(rad * L))
        RA = ((RA % 360) + 360) % 360
        RA += (math.floor(L / 90) * 90 - math.floor(RA / 90) * 90)
        RA /= 15
        sin_dec = 0.39782 * math.sin(rad * L)
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (math.cos(rad * zenith) - (sin_dec * math.sin(rad * lat))) / (cos_dec * math.cos(rad * lat))
        if cos_h > 1 or cos_h < -1:
            return None
        H = (360 - deg * math.acos(cos_h)) if rising else deg * math.acos(cos_h)
        H /= 15
        UT = (((H + RA - (0.06571 * t) - 6.622) - lng_hour) % 24 + 24) % 24
        return round((((UT + tz) % 24 + 24) % 24) * 60)

    return {"dawn": ev(96, True), "sunrise": ev(90.833, True),
            "sunset": ev(90.833, False), "dusk": ev(96, False)}


def _sun_block(date_str):
    a = _S.aerodrome
    s = sun_times(date_str, a["lat"], a["lng"], TZ)
    out = {k: _hhmm(v) for k, v in s.items()}
    out["note"] = f"civil twilight (dawn/dusk) & sunrise/sunset; tz {TZ:g}; aerodrome {a.get('name')}"
    return out


def _resolve_instructor(value):
    """-> (mode, instructor_id, label). mode is 'solo' | 'any' | 'specific'.
    Accepts '' (solo), 'any'/'anyone'/'cualquiera' (any available instructor),
    or an instructor name (substring) / userId for a specific one."""
    v = (value or "").strip()
    if v == "" or v.lower() in ("none", "no", "sin", "solo", "false", "0"):
        return ("solo", None, "solo (no instructor)")
    if v.lower() in ("any", "anyone", "cualquiera", "cualquier", "anyinstructor"):
        return ("any", None, "any available instructor")
    instructors = _get(f"/api/v3/school/id/{_S.school_id}/instructor") or []
    active = [{"id": i.get("userId"), "name": (i.get("user") or {}).get("name")}
              for i in instructors if i.get("status") == 1 and i.get("user")]
    if v.isdigit():
        uid = int(v)
        m = next((x for x in active if x["id"] == uid), None)
        return ("specific", uid, m["name"] if m else f"userId {uid}")
    matches = [x for x in active if v.lower() in (x["name"] or "").lower()]
    if len(matches) == 1:
        return ("specific", matches[0]["id"], matches[0]["name"])
    names = ", ".join(sorted(x["name"] for x in active if x["name"])) or "(none active)"
    if not matches:
        raise PilotfyError(f"No instructor matches '{value}'. Active instructors: {names}")
    raise PilotfyError(
        f"'{value}' matches several instructors: "
        + ", ".join(x["name"] for x in matches)
        + ". Be more specific, or pass the instructor's userId."
    )


# ── Tools: read-only (no confirmation needed) ────────────────────────────────
@mcp.tool()
def whoami() -> str:
    """Who am I in Pilotfy: my name, my school, and the school's turn rules
    (hours, how far ahead I can book, max turns per user) plus token expiry."""
    try:
        _boot()
        user = _S.user
        if not user:
            try:
                user = _get("/api/v3/user/profile") or {}
            except PilotfyError:
                user = {}
        exp = _jwt_exp(_S.token)
        return _json({
            "user": {"id": user.get("id"), "name": user.get("name"), "email": user.get("email")},
            "school": {
                "id": _S.school_id,
                "title": (_S.school.get("title") or "").strip(),
                "aerodromeCode": _S.school.get("aerodromeCode"),
                "turnsFrom": _S.turns_from,
                "turnsTo": _S.turns_to,
                "bookAheadWeeks": _S.weeks,
                "maxTurnsPerUser": _S.max_turns,
            },
            "aerodrome": _S.aerodrome,
            "session": {"tokenExpires": _fmt_epoch(exp) if exp else "unknown",
                        "tokenSource": _S.token_source},
        })
    except Exception as e:
        return _fail(e)


@mcp.tool()
def list_aircraft() -> str:
    """List the school's fleet (id, registration, brand, model, status).
    status 1 = active; `active` is true for bookable aircraft."""
    try:
        _boot()
        ac = _get(f"/api/v3/school/id/{_S.school_id}/aircraft") or []
        fleet = [{
            "id": a.get("id"),
            "registration": a.get("registration"),
            "brand": a.get("aircraftBrand"),
            "model": a.get("aircraftModel"),
            "status": a.get("status"),
            "active": a.get("status") == 1,
        } for a in ac]
        return _json({"schoolId": _S.school_id, "count": len(fleet), "aircraft": fleet})
    except Exception as e:
        return _fail(e)


@mcp.tool()
def get_availability(date: str) -> str:
    """Aircraft availability for a date (YYYY-MM-DD).

    For each active aircraft, returns the busy turns (time, pilot, instructor,
    reason, status) and the free gaps within school hours. Also includes
    sunrise/sunset and civil-twilight (dawn/dusk) for the aerodrome.
    Only Pendiente/Aprobado turns occupy an aircraft; cancelled ones are free.
    """
    try:
        _boot()
        _validate_date(date)
        turns = _get(f"/api/v3/school/id/{_S.school_id}/turns/date/{date}") or []
        ac = _get(f"/api/v3/school/id/{_S.school_id}/aircraft") or []
        fleet = [a for a in ac if a.get("status") == 1]
        start, end = _min(_S.turns_from), _min(_S.turns_to)

        out = []
        for a in fleet:
            occ = [t for t in turns
                   if t.get("planeId") == a.get("id") and t.get("turnStatus") in OCCUPYING]
            occ.sort(key=lambda t: _min(t.get("timeFrom", "00:00")))
            busy = [{
                "timeFrom": t.get("timeFrom"),
                "timeTo": t.get("timeTo"),
                "pilot": (t.get("user") or {}).get("name"),
                "instructor": _instr_label(t),
                "reason": _reason_name(t.get("reason")),
                "status": _status_name(t.get("turnStatus")),
                "turnId": t.get("id"),
            } for t in occ]
            gaps = _free_gaps([(_min(b["timeFrom"]), _min(b["timeTo"])) for b in busy], start, end)
            free = [{"from": _hhmm(f), "to": _hhmm(t), "durationMin": t - f} for f, t in gaps]
            out.append({
                "id": a.get("id"),
                "registration": a.get("registration"),
                "model": f"{a.get('aircraftBrand') or ''} {a.get('aircraftModel') or ''}".strip(),
                "busy": busy,
                "free": free,
            })
        return _json({
            "date": date,
            "schoolHours": {"from": _S.turns_from, "to": _S.turns_to},
            "sun": _sun_block(date),
            "aircraft": out,
        })
    except Exception as e:
        return _fail(e)


@mcp.tool()
def my_turns(include_past: bool = False) -> str:
    """My reservations (upcoming by default; set include_past=True for all).
    Shows status, aircraft, instructor and reason, plus how many active turns
    I hold against the school's per-user maximum."""
    try:
        _boot()
        turns = _get(f"/api/v3/school/id/{_S.school_id}/turns") or []
        today = _today().isoformat()
        rows = []
        for t in turns:
            d = t.get("date", "") or ""
            if not include_past and d and d < today:
                continue
            rows.append({
                "id": t.get("id"),
                "date": d,
                "timeFrom": t.get("timeFrom"),
                "timeTo": t.get("timeTo"),
                "aircraft": (t.get("aircraft") or {}).get("registration"),
                "model": (t.get("aircraft") or {}).get("aircraftModel"),
                "reason": _reason_name(t.get("reason")),
                "instructor": _instr_label(t),
                "status": _status_name(t.get("turnStatus")),
                "turnStatus": t.get("turnStatus"),
            })
        rows.sort(key=lambda r: (r["date"] or "", _min(r["timeFrom"] or "00:00")))
        active = [r for r in rows if r["turnStatus"] in OCCUPYING]
        return _json({
            "count": len(rows),
            "activeCount": len(active),
            "maxTurnsPerUser": _S.max_turns,
            "turns": rows,
        })
    except Exception as e:
        return _fail(e)


# ── Tools: write actions (gated behind confirm=True) ─────────────────────────
@mcp.tool()
def book_turn(planeId: int, date: str, timeFrom: str, timeTo: str, reason: int,
              instructor: str = "", confirm: bool = False) -> str:
    """Book an aircraft turn. REAL action at a real aeroclub.

    Args:
        planeId:   aircraft id (from list_aircraft / get_availability)
        date:      YYYY-MM-DD
        timeFrom:  HH:mm (24h), within school hours
        timeTo:    HH:mm (24h), after timeFrom
        reason:    1 Vuelo Privado · 2 Instrucción Alumno · 3 Readaptación ·
                   4 Navegación · 5 Bautismo · 6 Adaptación · 7 Vuelo No Regular ·
                   8 Prueba de Aeronaves · 9 Trabajo Aéreo · 10 Examen
        instructor: optional. Empty/'solo' = solo flight; 'any' = any available
                   instructor; or an instructor name / userId for a specific one.
                   Reasons 2 (Instrucción) and 3 (Readaptación) require an instructor.
        confirm:   MUST be True to actually book. When False (default), this only
                   validates and returns a summary + the exact payload for the
                   user to approve — nothing is sent.

    Always show the returned summary to the user and get their OK before
    re-calling with confirm=True. New turns are created as Pendiente until the
    school approves them.
    """
    try:
        _boot()
        target = _validate_date(date)
        _validate_time(timeFrom)
        _validate_time(timeTo)

        problems = []
        warnings = []

        # NB: the `date` parameter shadows datetime.date inside this function, so
        # we use _today() (aerodrome TZ) and parse via _validate_date (module scope).
        today_d = _today()
        latest = today_d + timedelta(days=_S.weeks * 7 - 1)
        if target < today_d:
            problems.append(f"date {date} is in the past")
        elif target > latest:
            problems.append(f"date {date} is beyond the {_S.weeks}-week booking window (latest {latest.isoformat()})")

        f, t = _min(timeFrom), _min(timeTo)
        sf, st = _min(_S.turns_from), _min(_S.turns_to)
        if t <= f:
            problems.append("timeTo must be after timeFrom")
        if f < sf or t > st:
            problems.append(f"requested {timeFrom}–{timeTo} is outside school hours {_S.turns_from}–{_S.turns_to}")

        if reason not in REASON:
            problems.append(f"invalid reason {reason}; must be one of {sorted(REASON)}")

        ac = _get(f"/api/v3/school/id/{_S.school_id}/aircraft") or []
        plane = next((a for a in ac if a.get("id") == planeId), None)
        if plane is None:
            problems.append(f"no aircraft with id {planeId} (use list_aircraft)")
        elif plane.get("status") != 1:
            warnings.append(f"aircraft {plane.get('registration')} is not marked active (status {plane.get('status')})")

        instr_mode, instr_id, instr_lbl = _resolve_instructor(instructor)
        if reason in INSTRUCTOR_REQUIRED and instr_mode == "solo":
            problems.append(
                f"reason “{_reason_name(reason)}” requires an instructor "
                "(pass instructor=<name>, a userId, or 'any')"
            )

        # Overlap pre-check against existing Pendiente/Aprobado turns for this plane.
        if not problems:
            day_turns = _get(f"/api/v3/school/id/{_S.school_id}/turns/date/{date}") or []
            clashes = [tt for tt in day_turns
                       if tt.get("planeId") == planeId and tt.get("turnStatus") in OCCUPYING
                       and _overlaps(f, t, _min(tt.get("timeFrom", "00:00")), _min(tt.get("timeTo", "00:00")))]
            if clashes:
                c = clashes[0]
                problems.append(
                    f"that slot overlaps an existing {_status_name(c.get('turnStatus'))} turn "
                    f"{c.get('timeFrom')}–{c.get('timeTo')} on {plane.get('registration')}"
                )

        # Per-user max active turns.
        if not problems and _S.max_turns:
            mine = _get(f"/api/v3/school/id/{_S.school_id}/turns") or []
            today_iso = today_d.isoformat()
            active_mine = [x for x in mine
                           if x.get("turnStatus") in OCCUPYING and (x.get("date", "") or "") >= today_iso]
            if len(active_mine) >= _S.max_turns:
                problems.append(f"you already hold {len(active_mine)} active turns (max {_S.max_turns})")

        if problems:
            return _json({"status": "validation_failed", "problems": problems, "warnings": warnings})

        # The API is strict (Joi: object.allowUnknown). Send ONLY these keys plus
        # EXACTLY ONE instructor field. Do NOT send visibleDate or hasInstructor —
        # the app strips those before POSTing and the API rejects the whole request.
        payload = {
            "schoolId": _S.school_id,
            "planeId": planeId,
            "date": date,
            "timeFrom": timeFrom,
            "timeTo": timeTo,
            "reason": reason,
        }
        if instr_mode == "specific":
            payload["instructorId"] = instr_id
        elif instr_mode == "any":
            payload["anyInstructor"] = 1
        else:  # solo
            payload["withoutInstructor"] = 1

        model = f"{(plane.get('aircraftBrand') or '').strip()} {(plane.get('aircraftModel') or '').strip()}".strip()
        instr_text = f"with instructor {instr_lbl}" if instr_mode == "specific" else instr_lbl
        summary = (
            f"Book {plane.get('registration')} ({model}) on {date} "
            f"{timeFrom}–{timeTo} ({_dur(t - f)}), reason “{_reason_name(reason)}”, "
            f"{instr_text}. Created as Pendiente until the school approves."
        )

        if not confirm:
            return _json({
                "status": "needs_confirmation",
                "summary": summary,
                "payload": payload,
                "warnings": warnings,
                "note": "Show this to the user. Re-call book_turn with confirm=True to actually create it.",
            })

        resp = _api("POST", f"/api/v3/school/id/{_S.school_id}/turns", payload)
        data = resp.get("data") if isinstance(resp, dict) else None
        created = data.get("turn") if isinstance(data, dict) and "turn" in data else data
        waitlisted = resp.get("isInWaitlist") if isinstance(resp, dict) else None
        return _json({
            "status": "booked",
            "message": ("Added to the waitlist for this slot." if waitlisted
                        else "Turn created as Pendiente (awaiting school approval)."),
            "summary": summary,
            "warnings": warnings,
            "isInWaitlist": waitlisted,
            "turn": created,
        })
    except Exception as e:
        return _fail(e)


@mcp.tool()
def cancel_turn(turnId: int, confirm: bool = False) -> str:
    """Cancel one of my turns (sets status = Cancelado por piloto). REAL action.

    Args:
        turnId:  the turn id (from my_turns / get_availability)
        confirm: MUST be True to actually cancel. When False (default), returns a
                 summary of the turn for the user to approve — nothing is sent.

    Always show the summary to the user and get their OK before re-calling with
    confirm=True.
    """
    try:
        _boot()
        mine = _get(f"/api/v3/school/id/{_S.school_id}/turns") or []
        t = next((x for x in mine if x.get("id") == turnId), None)

        if t is not None:
            reg = (t.get("aircraft") or {}).get("registration") or "?"
            summary = (
                f"Cancel your turn #{turnId}: {reg} on {t.get('date')} "
                f"{t.get('timeFrom')}–{t.get('timeTo')} "
                f"({_reason_name(t.get('reason'))}, currently {_status_name(t.get('turnStatus'))})."
            )
            if t.get("turnStatus") not in OCCUPYING:
                return _json({
                    "status": "already_inactive",
                    "summary": summary,
                    "note": "This turn is already cancelled/closed — nothing to do.",
                })
        else:
            summary = (f"Cancel turn #{turnId}. (Not found among your upcoming turns — it may be "
                       "in the past, already cancelled, or not yours. The API will reject it if you "
                       "can't cancel it.)")

        if not confirm:
            return _json({
                "status": "needs_confirmation",
                "summary": summary,
                "note": "Show this to the user. Re-call cancel_turn with confirm=True to cancel.",
            })

        resp = _api("PUT", f"/api/v3/school/id/{_S.school_id}/turns/status",
                    {"id": turnId, "status": 3})
        result = resp.get("data") if isinstance(resp, dict) and "data" in resp else resp
        return _json({"status": "cancelled", "summary": summary, "result": result})
    except Exception as e:
        return _fail(e)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Pilotfy MCP Server")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio",
                        help="Transport method (stdio or sse)")
    args = parser.parse_args()

    if EMAIL and PASSWORD:
        mode = "email/password"
    elif STATIC_TOKEN:
        mode = "token"
    else:
        mode = "NONE"
    # Log to stderr only — stdout is the MCP protocol channel under stdio.
    print(f"Starting Pilotfy MCP Server ({args.transport}; auth={mode}; host={BASE})...", file=sys.stderr)
    if mode == "NONE":
        print("WARNING: no credentials. Set PILOTFY_EMAIL+PILOTFY_PASSWORD or PILOTFY_TOKEN.", file=sys.stderr)

    mcp.run(transport=args.transport)
