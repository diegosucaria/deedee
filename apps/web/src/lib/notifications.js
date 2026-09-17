// Notification helpers shared by the bell and the notifications page.
//
// Rows carry a `type` the agent sets at the call site (delivery_failure,
// system_alert, model_failure, ask_user, ...). The dashboard used to hide it,
// so two very different rows looked the same. These helpers name the type and
// filter by it.

// Types worth a word of their own; anything else falls back to the snake_case
// name with the underscores removed.
const TYPE_LABELS = {
    ask_user: 'Question',
    delivery_failure: 'Not delivered',
    delivery_dead: 'Delivery given up',
    rag_reindex_required: 'Search index',
    agent_loop_limit: 'Loop limit',
};

// Tailwind classes per type family. Everything unknown gets the neutral one.
const TYPE_STYLES = {
    ask_user: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    delivery_failure: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    delivery_dead: 'bg-red-500/10 text-red-300 border-red-500/20',
    system_alert: 'bg-red-500/10 text-red-300 border-red-500/20',
};

const NEUTRAL_STYLE = 'bg-zinc-800 text-zinc-400 border-zinc-700';

/** Human label for a notification type. */
export function notificationTypeLabel(type) {
    if (!type) return 'Other';
    if (TYPE_LABELS[type]) return TYPE_LABELS[type];
    const words = String(type).replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
}

/** Badge classes for a notification type. */
export function notificationTypeStyle(type) {
    return TYPE_STYLES[type] || NEUTRAL_STYLE;
}

/** 'all' plus every type present in the rows, sorted, for the filter row. */
export function notificationTypeOptions(notifications = []) {
    const types = new Set();
    for (const n of notifications) {
        if (n && n.type) types.add(n.type);
    }
    return ['all', ...Array.from(types).sort()];
}

/**
 * Filter rows by severity, type and read/dismissed status.
 * status: 'active' (not dismissed) | 'unread' | 'dismissed'.
 */
export function filterNotifications(notifications = [], { severity = 'all', type = 'all', status = 'active' } = {}) {
    return notifications.filter(n => {
        if (severity !== 'all' && n.severity !== severity) return false;
        if (type !== 'all' && n.type !== type) return false;
        if (status === 'active' && n.is_dismissed) return false;
        if (status === 'unread' && (n.is_read || n.is_dismissed)) return false;
        if (status === 'dismissed' && !n.is_dismissed) return false;
        return true;
    });
}
