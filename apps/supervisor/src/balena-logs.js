const { Readable } = require('stream');

const HEARTBEAT_MS = 15000;

// Container logs through the balena supervisor API instead of the engine
// socket. The engine socket can start a privileged container, which is root
// on the host; this API can read the journal and restart services, but it
// cannot run a container of its choosing. balenaOS engines log to journald,
// and every container line there carries CONTAINER_ID_FULL.

/** True when the service runs with io.balena.features.supervisor-api. */
function balenaApiAvailable(env = process.env) {
  return Boolean(env.BALENA_SUPERVISOR_ADDRESS && env.BALENA_SUPERVISOR_API_KEY);
}

/** journalctl date for a `10m` / `2h` / `1d` duration, a unix time, or a date. */
function journalSince(value, now = Date.now()) {
  if (!value) return undefined;
  const str = String(value);
  const rel = str.match(/^(\d+)(m|h|d)$/);
  let ms;
  if (rel) {
    const unit = { m: 60, h: 3600, d: 86400 }[rel[2]];
    ms = now - Number(rel[1]) * unit * 1000;
  } else if (/^\d{9,11}$/.test(str)) {
    ms = Number(str) * 1000;
  } else {
    ms = Date.parse(str);
  }
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/** The MESSAGE field of a journal row as text (journald may send bytes). */
function messageText(row) {
  const msg = row.MESSAGE;
  if (Array.isArray(msg)) return Buffer.from(msg).toString('utf8');
  return msg == null ? '' : String(msg);
}

class BalenaLogs {
  constructor({ env = process.env, fetchImpl } = {}) {
    this.address = env.BALENA_SUPERVISOR_ADDRESS;
    this.apiKey = env.BALENA_SUPERVISOR_API_KEY;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
  }

  _headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  /** { serviceName: containerId } for the services of this app. */
  async containerIds() {
    const res = await this.fetch(`${this.address}/v2/containerId`, {
      headers: this._headers(),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`balena supervisor returned ${res.status}`);
    const data = await res.json();
    return data.services || {};
  }

  /**
   * Streams journal lines for the named services to `out`, one line each,
   * prefixed with the service name when there is more than one.
   * @returns {Promise<{ stop: Function }>}
   */
  async stream({ services, tail, since, until, follow = true, out }) {
    const ids = await this.containerIds();
    const wanted = new Map();
    for (const name of services) {
      if (ids[name]) wanted.set(ids[name], name);
    }
    if (wanted.size === 0) {
      const err = new Error(`Container '${services.join(', ')}' not found`);
      err.status = 404;
      throw err;
    }

    const lines = Math.min(Math.max(Number(tail) || 200, 1), 5000);
    const body = {
      follow,
      format: 'json',
      // The count covers the whole journal, host lines included, so ask for
      // more than the tail and filter here.
      ...(since || until ? {} : { count: lines * 10 }),
      ...(since ? { since: journalSince(since) } : {}),
      ...(until ? { until: journalSince(until) } : {})
    };

    const controller = new AbortController();
    const res = await this.fetch(`${this.address}/v2/journal-logs`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok || !res.body) throw new Error(`balena supervisor returned ${res.status}`);

    const prefix = wanted.size > 1;
    let buffer = '';
    const stream = Readable.fromWeb(res.body);
    stream.on('data', (chunk) => {
      const parts = (buffer + chunk.toString('utf8')).split('\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part) continue;
        let row;
        try { row = JSON.parse(part); } catch { continue; }
        const name = wanted.get(row.CONTAINER_ID_FULL);
        if (!name) continue;
        const text = messageText(row);
        out.write(prefix ? `[${name}] ${text}\n` : `${text}\n`);
      }
    });
    // A line every 15 s keeps the proxies between here and the browser from
    // timing out when no service writes for minutes. The dockerode path sends
    // the same line.
    const heartbeat = follow
      ? setInterval(() => { if (!out.writableEnded) out.write('[SYSTEM] HEARTBEAT\n'); }, HEARTBEAT_MS)
      : null;
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
    const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); };
    stream.on('error', stopHeartbeat);
    stream.on('end', () => {
      stopHeartbeat();
      if (typeof out.end === 'function') out.end();
    });

    return {
      stop: () => {
        stopHeartbeat();
        controller.abort();
        stream.destroy();
      }
    };
  }
}

module.exports = { BalenaLogs, balenaApiAvailable, journalSince, messageText };
