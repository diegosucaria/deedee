/**
 * Calendar Filter
 *
 * Filters GWS calendar tool responses to only include calendars the user has
 * configured as visible. Runs BEFORE the tool-result-sanitizer because the
 * sanitizer strips the `id` / `primary` fields needed for filtering.
 *
 * Default behaviour (no config): primary calendar only.
 */

/**
 * @param {string} toolName   - Namespaced tool name (e.g. "personal_calendar")
 * @param {*}      result     - Raw MCP tool result ({ output: "JSON string" })
 * @param {Object} settings   - agent.settings (key → parsed value)
 * @param {Map}    mcpToolMap - MCPManager.toolMap  (toolName → { name, client, originalName })
 * @param {Object} [args]     - the call's arguments; `params.calendarId` names the calendar that was read
 * @returns {*} Filtered result (or original if not applicable)
 */
function filterCalendarResult(toolName, result, settings, mcpToolMap, args) {
    if (!toolName || !result) return result;

    // Quick exit: only process calendar tools
    if (!toolName.toLowerCase().includes('calendar')) return result;

    // Resolve which GWS account this tool belongs to
    const toolEntry = mcpToolMap && mcpToolMap.get(toolName);
    if (!toolEntry || !toolEntry.name || !toolEntry.name.startsWith('gws_')) return result;

    const safeLabel = toolEntry.name.replace(/^gws_/, '');

    // Load filter config for this account
    const filterKey = `gws_calendar_filter:${safeLabel}`;
    const filterConfig = settings && settings[filterKey];

    // Determine allowed calendar IDs
    // null → primary-only mode (safe default)
    const allowedIds = (filterConfig && Array.isArray(filterConfig.calendarIds) && filterConfig.calendarIds.length > 0)
        ? new Set(filterConfig.calendarIds)
        : null;

    // Parse the MCP response (shape: { output: "JSON string" })
    if (!result || typeof result.output !== 'string') return result;

    let parsed;
    try {
        parsed = JSON.parse(result.output);
    } catch {
        return result;
    }

    const filtered = filterParsed(parsed, allowedIds, calendarIdOf(args));
    if (filtered === parsed) return result; // no change

    return { ...result, output: JSON.stringify(filtered) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The calendar a call read: `params.calendarId` (an object or a JSON string) or `calendarId`. */
function calendarIdOf(args) {
    if (!args || typeof args !== 'object') return null;
    let params = args.params;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
    const id = (params && typeof params === 'object' ? params.calendarId : null) ?? args.calendarId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Route to the right filter based on response shape.
 */
function filterParsed(obj, allowedIds, calendarId = null) {
    if (!obj || typeof obj !== 'object') return obj;

    // calendarList.list → { kind: "calendar#calendarList", items: [...] }
    if (obj.kind === 'calendar#calendarList' || (Array.isArray(obj.items) && obj.items[0]?.accessRole)) {
        return filterCalendarList(obj, allowedIds);
    }

    // +agenda helper or events.list returning events from mixed calendars
    // Events have start/end; calendar list entries have accessRole
    if (Array.isArray(obj.items) && obj.items[0]?.start) {
        return filterEventsList(obj, allowedIds, calendarId);
    }

    // Top-level array of events (some helpers return plain arrays)
    if (Array.isArray(obj) && obj[0]?.start) {
        const filtered = filterEventsArray(obj, allowedIds, calendarId);
        return filtered.length === obj.length ? obj : filtered;
    }

    return obj;
}

/**
 * Filter a calendarList.list response.
 * Keeps only calendars whose id is in allowedIds, or only the primary calendar
 * when allowedIds is null.
 */
function filterCalendarList(response, allowedIds) {
    if (!Array.isArray(response.items)) return response;

    const before = response.items.length;
    const filtered = response.items.filter(cal => {
        if (allowedIds) return allowedIds.has(cal.id);
        return cal.primary === true;
    });

    if (filtered.length === before) return response;

    console.log(`[CalendarFilter] calendarList filtered: ${before} → ${filtered.length} calendars`);
    return { ...response, items: filtered };
}

/**
 * Filter an events.list response (has items array with event objects).
 * Uses organizer.email or the response-level summary to match calendar.
 */
function filterEventsList(response, allowedIds, calendarId = null) {
    if (!Array.isArray(response.items)) return response;

    const before = response.items.length;
    const filtered = filterEventsArray(response.items, allowedIds, calendarId);
    if (filtered.length === before) return response;

    console.log(`[CalendarFilter] events filtered: ${before} → ${filtered.length} events`);
    return { ...response, items: filtered };
}

/**
 * Filter an array of event objects.
 *
 * The calendar the events were READ from decides, when the call names it.
 * This used to go by `organizer.email` alone, on the belief that Google puts
 * the owning calendar's id there. That holds for an event made on a shared
 * calendar; for an invitation it is the person who sent it. So every meeting
 * someone else organised was dropped from the owner's own calendar, and the
 * model (and the morning briefing) never saw it.
 *
 * - `primary`, or an id on the allow-list: every event on it is his to see.
 * - an id that is not on the allow-list: nothing.
 * - no id to go by (a helper that mixes calendars, or primary-only mode with
 *   an explicit id): event by event. It is his when he organised it, made it
 *   or is invited to it, or when it sits on an allowed shared calendar.
 */
function filterEventsArray(events, allowedIds, calendarId = null) {
    const allowed = allowedIds ? new Set([...allowedIds].map(id => String(id).toLowerCase())) : null;
    if (calendarId) {
        const id = calendarId.toLowerCase();
        if (id === 'primary') return events;
        if (allowed) return allowed.has(id) ? events : [];
    }
    return events.filter(ev => {
        if (ev?.organizer?.self === true || ev?.creator?.self === true) return true;
        if (Array.isArray(ev?.attendees) && ev.attendees.some(a => a?.self === true)) return true;
        const organizer = ev?.organizer?.email;
        if (!allowed) return false; // primary-only: not his event
        if (!organizer) return true; // keep if we can't determine source
        return allowed.has(String(organizer).toLowerCase());
    });
}

module.exports = { filterCalendarResult };
