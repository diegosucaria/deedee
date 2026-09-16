/**
 * SentIds: the ids of messages this service already handed to a transport.
 *
 * The agent's delivery ledger retries a send when the HTTP answer is lost,
 * even if the message reached WhatsApp or Telegram. The retry carries the
 * same message id, so the /send handler and the transport services check
 * this set and answer { success: true, duplicate: true } instead of sending
 * again. Ids live for 24 h; the set is in memory and empties on restart.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60e3;
const DEFAULT_MAX = 10000;

class SentIds {
    constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        /** id -> time it was marked, insertion ordered */
        this.map = new Map();
    }

    /** True when `id` was marked less than ttl ago. */
    has(id) {
        if (!id) return false;
        const key = String(id);
        const at = this.map.get(key);
        if (at === undefined) return false;
        if (Date.now() - at > this.ttlMs) {
            this.map.delete(key);
            return false;
        }
        return true;
    }

    /** Mark `id` as sent now. Falsy ids are ignored. */
    add(id) {
        if (!id) return;
        const key = String(id);
        this.map.delete(key);
        this.map.set(key, Date.now());
        if (this.map.size > this.max) this._sweep();
    }

    /** Forget `id` (a send that failed after all). */
    delete(id) {
        if (id) this.map.delete(String(id));
    }

    get size() { return this.map.size; }

    _sweep() {
        const now = Date.now();
        for (const [key, at] of this.map) {
            if (now - at > this.ttlMs) this.map.delete(key);
        }
        while (this.map.size > this.max) {
            this.map.delete(this.map.keys().next().value);
        }
    }
}

module.exports = { SentIds, DEFAULT_TTL_MS };
