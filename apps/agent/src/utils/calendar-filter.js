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
 * @param {Object} [mcpConfig] - MCPManager.config (server name → config); its env names the account, whose address is the id of `primary`
 * @returns {*} Filtered result (or original if not applicable)
 */
function filterCalendarResult(toolName, result, settings, mcpToolMap, args, mcpConfig) {
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

    // `primary` is a nickname: the account's own address is that calendar's id.
    const account = mcpConfig?.[toolEntry.name]?.env?.GOOGLE_WORKSPACE_CLI_ACCOUNT;
    const primaryId = typeof account === 'string' && account.trim() ? account.trim().toLowerCase() : null;

    // 'get', 'events.get' and 'Events.Get' are the same method.
    const method = String(args?.method || '').split('.').pop().trim().toLowerCase();
    const filtered = filterParsed(parsed, allowedIds, calendarIdOf(args), primaryId, method);
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
function filterParsed(obj, allowedIds, calendarId = null, primaryId = null, method = '') {
    if (!obj || typeof obj !== 'object') return obj;

    // calendarList.list → { kind: "calendar#calendarList", items: [...] }
    if (obj.kind === 'calendar#calendarList' || (Array.isArray(obj.items) && obj.items[0]?.accessRole)) {
        return filterCalendarList(obj, allowedIds);
    }

    // +agenda helper or events.list returning events from mixed calendars
    // Events have start/end; calendar list entries have accessRole
    if (Array.isArray(obj.items) && obj.items[0]?.start) {
        return filterEventsList(obj, allowedIds, calendarId, primaryId);
    }

    // Top-level array of events (some helpers return plain arrays)
    if (Array.isArray(obj) && obj[0]?.start) {
        const filtered = filterEventsArray(obj, allowedIds, calendarId, primaryId);
        return filtered.length === obj.length ? obj : filtered;
    }

    // events.get: one event. It used to pass whole, whatever calendar it was on.
    // Only a READ is judged. The result of insert, patch, update, move or
    // quickAdd is a single event too: turning that into an error would tell
    // the model a meeting was not created when Google did create it, and it
    // would create it again.
    if ((!method || method === 'get') && !Array.isArray(obj) && obj.start) {
        return filterEventsArray([obj], allowedIds, calendarId, primaryId).length === 1
            ? obj
            : { error: 'That event is on a calendar the owner has not made visible.' };
    }

    // free/busy is left as it comes: it holds busy blocks only, no titles or
    // guests, and "when is this person free" is the question it exists for.

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
function filterEventsList(response, allowedIds, calendarId = null, primaryId = null) {
    if (!Array.isArray(response.items)) return response;

    const before = response.items.length;
    const filtered = filterEventsArray(response.items, allowedIds, calendarId, primaryId);
    if (filtered.length === before) return response;

    console.log(`[CalendarFilter] events filtered: ${before} → ${filtered.length} events`);
    return { ...response, items: filtered };
}

/**
 * Which calendars the owner made visible.
 * `calendar(id)` answers true, false, or null when it cannot tell.
 *
 * `primary` is a nickname for the account's own calendar, whose real id is
 * the account's address. With an allow-list it is visible only when that id
 * is ticked: an owner who unticks his own calendar and leaves a shared one
 * must not see it again because a call said `primary`.
 */
function visibility(allowedIds, primaryId) {
    const allowed = allowedIds ? new Set([...allowedIds].map(id => String(id).toLowerCase())) : null;
    // With a list, `primary` shows only when the account's own address is
    // ticked. An account we cannot name (every writer of the config names it)
    // keeps `primary` hidden: guessing from the list let a ticked colleague's
    // address open the owner's whole calendar.
    const primaryVisible = !allowed ? true : (primaryId ? allowed.has(primaryId) : false);
    return {
        allowed,
        primaryVisible,
        calendar(rawId) {
            const id = String(rawId || '').toLowerCase();
            if (!id) return null;
            if (id === 'primary' || (primaryId && id === primaryId)) return primaryVisible;
            if (allowed) return allowed.has(id);
            return null; // primary-only mode, another calendar: judge event by event
        },
    };
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
 * - a visible calendar (see `visibility`): every event on it is his to see;
 * - a calendar that is not visible: nothing;
 * - no way to tell (a helper that mixes calendars, or primary-only mode with
 *   another calendar's id): event by event. An event he organised, made or
 *   is invited to sits on his own calendar, so it follows `primary`. Any
 *   other event is kept when it sits on an allowed shared calendar.
 */
function filterEventsArray(events, allowedIds, calendarId = null, primaryId = null) {
    const visible = visibility(allowedIds, primaryId);
    const read = visible.calendar(calendarId);
    if (read === true) return events;
    if (read === false) return [];
    return events.filter(ev => {
        // An event made ON a shared calendar names that calendar as its
        // organizer: a ticked one shows, whoever made the event.
        const organizer = ev?.organizer?.email ? String(ev.organizer.email).toLowerCase() : null;
        if (visible.allowed && organizer && visible.allowed.has(organizer)) return true;
        const his = ev?.organizer?.self === true || ev?.creator?.self === true
            || (Array.isArray(ev?.attendees) && ev.attendees.some(a => a?.self === true));
        if (his) return visible.primaryVisible;
        if (!visible.allowed) return false; // primary-only: not his event
        return !organizer; // keep if we can't determine source
    });
}

module.exports = { filterCalendarResult };
