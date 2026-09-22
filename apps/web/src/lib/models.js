// Helpers for the Models tab (/system/models). They live here, away from the
// page, so they can be tested without a browser. See docs/models.md.

/** A price in dollars per million tokens. Two to three digits, no noise. */
export function formatPrice(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
    const n = Number(value);
    if (n === 0) return 'free';
    return `$${n.toFixed(3).replace(/0$/, '')}`;
}

/** 200000 -> "200k". Used in the tier label. */
export function shortCount(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 1_000_000) return `${n / 1_000_000}M`;
    if (n >= 1_000) return `${n / 1_000}k`;
    return String(n);
}

/**
 * One line per price tier. Flat prices give a single line with no label; a
 * tiered price (Pro) gives two, split at the threshold.
 * @param {object} price the `price` field of a role from GET /v1/models
 * @returns {Array<{label: string|null, input: number, output: number, cachedInput: number, outputText: number|null}>}
 */
export function priceLines(price) {
    if (!price || !price.tier1) return [];
    const line = (tier, label) => ({
        label,
        input: tier.input,
        output: tier.output,
        cachedInput: tier.cachedInput ?? null,
        outputText: tier.outputText ?? null
    });
    const flat = !price.tier2 || JSON.stringify(price.tier1) === JSON.stringify(price.tier2);
    if (flat) return [line(price.tier1, null)];
    const at = shortCount(price.threshold);
    return [line(price.tier1, at ? `up to ${at}` : 'tier 1'), line(price.tier2, at ? `over ${at}` : 'tier 2')];
}

/** How long ago, short. Same wording as the notification bell. */
export function timeAgo(at, now = Date.now()) {
    if (!at) return 'never';
    const then = new Date(at).getTime();
    if (!Number.isFinite(then)) return 'never';
    const seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export const SMOKE_STYLES = {
    ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    fail: 'bg-red-500/10 text-red-400 border-red-500/20',
    skip: 'bg-amber-500/10 text-amber-400 border-amber-500/20'
};

/** Badge colour for a smoke status; an unknown status stays grey. */
export function smokeStyle(status) {
    return SMOKE_STYLES[status] || 'bg-zinc-800 text-zinc-400 border-zinc-700';
}
