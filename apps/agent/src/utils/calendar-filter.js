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
 * @returns {*} Filtered result (or original if not applicable)
 */
function filterCalendarResult(toolName, result, settings, mcpToolMap) {
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

    const filtered = filterParsed(parsed, allowedIds);
    if (filtered === parsed) return result; // no change

    return { ...result, output: JSON.stringify(filtered) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Route to the right filter based on response shape.
 */
function filterParsed(obj, allowedIds) {
    if (!obj || typeof obj !== 'object') return obj;

    // calendarList.list → { kind: "calendar#calendarList", items: [...] }
    if (obj.kind === 'calendar#calendarList' || (Array.isArray(obj.items) && obj.items[0]?.accessRole)) {
        return filterCalendarList(obj, allowedIds);
    }

    // +agenda helper or events.list returning events from mixed calendars
    // Events have start/end; calendar list entries have accessRole
    if (Array.isArray(obj.items) && obj.items[0]?.start) {
        return filterEventsList(obj, allowedIds);
    }

    // Top-level array of events (some helpers return plain arrays)
    if (Array.isArray(obj) && obj[0]?.start) {
        const filtered = filterEventsArray(obj, allowedIds);
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
function filterEventsList(response, allowedIds) {
    if (!Array.isArray(response.items)) return response;

    const before = response.items.length;
    const filtered = filterEventsArray(response.items, allowedIds);
    if (filtered.length === before) return response;

    console.log(`[CalendarFilter] events filtered: ${before} → ${filtered.length} events`);
    return { ...response, items: filtered };
}

/**
 * Filter an array of event objects.
 * Matches against organizer.email, which Google Calendar always populates
 * with the calendar ID that owns the event.
 */
function filterEventsArray(events, allowedIds) {
    if (!allowedIds) {
        // Primary-only: keep events where organizer.self is true
        return events.filter(ev => ev.organizer?.self === true);
    }
    return events.filter(ev => {
        const calId = ev.organizer?.email;
        if (!calId) return true; // keep if we can't determine source
        return allowedIds.has(calId);
    });
}

module.exports = { filterCalendarResult };
