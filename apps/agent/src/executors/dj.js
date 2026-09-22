const { createAssistantMessage } = require('@deedee/shared/src/types');

// At most this many searches in one search_vinyls call.
const MAX_SEARCH_QUERIES = 50;

/**
 * When a record entered the crate, as the model should read it: "just now",
 * minutes or hours for a fresh row, the date for an old one. A record added
 * seconds ago used to look like one the owner had kept for years.
 */
function addedLabel(createdAt, now = Date.now()) {
    if (!createdAt) return '';
    const raw = String(createdAt);
    const t = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
    if (Number.isNaN(t)) return '';
    const mins = Math.max(0, Math.round((now - t) / 60000));
    if (mins < 1) return 'added just now';
    if (mins < 60) return `added ${mins} min ago`;
    if (mins < 48 * 60) return `added ${Math.round(mins / 60)} h ago`;
    return `added ${new Date(t).toISOString().slice(0, 10)}`;
}

/** The image attachments on the owner's current message. */
function imagePartsOf(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts.filter(p => p?.inlineData && typeof p.inlineData.data === 'string'
        && String(p.inlineData.mimeType || '').startsWith('image/'));
}

class DJExecutor {
    constructor(services) {
        this.services = services;
        this.djService = services.dj;
    }

    async execute(name, args, context) {
        switch (name) {
            case 'add_vinyl':
                return this.add_vinyl(args, context);
            case 'list_vinyls':
                return this.list_vinyls(args);
            case 'get_vinyl':
                return this.get_vinyl(args);
            case 'search_vinyls':
                return this.search_vinyls(args);
            case 'list_crate_tracks':
                return this.list_crate_tracks(args);
            case 'recommend_vinyl':
                return this.recommend_vinyl(args);
            case 'ingest_dj_history':
                return this.ingest_dj_history(args);
            case 'recommend_digital':
                return this.recommend_digital(args);
            default:
                return null;
        }
    }

    /**
     * With no image_path, the photo is the one attached to the owner's
     * current message. Before, the tool could not see a chat photo at all,
     * so a background step wrote the crate instead, ask or no ask.
     */
    async add_vinyl({ image_path } = {}, context = {}) {
        try {
            let results;
            if (image_path) {
                results = await this.djService.ingestVinyl(image_path, 'auto');
            } else {
                const images = imagePartsOf(context.message);
                if (images.length === 0) {
                    return "No photo to read: nothing was added. The owner attaches the photo of the cover, label or receipt to the message that asks to add it, or you pass image_path.";
                }
                results = [];
                const failures = [];
                for (const part of images) {
                    try {
                        results.push(...(await this.djService.ingestVinylFromBase64(part.inlineData.data, part.inlineData.mimeType)));
                    } catch (e) {
                        failures.push(e.message);
                    }
                }
                if (results.length === 0 && failures.length > 0) return `Failed to ingest vinyl: ${failures.join('; ')}`;
                if (failures.length > 0) console.warn(`[DJExecutor] add_vinyl: ${failures.length} of ${images.length} photos could not be read: ${failures.join('; ')}`);
            }
            if (!results || results.length === 0) return "No vinyls detected or confidence too low.";

            const line = v => `- **${v.artist}** - ${v.title} (${v.label})`;
            const added = results.filter(v => !v._preExisting);
            const known = results.filter(v => v._preExisting);
            const out = [];
            if (added.length > 0) out.push(`Added ${added.length} vinyls to your crate (details still loading):\n${added.map(line).join('\n')}`);
            if (known.length > 0) out.push(`Already in the crate, details refreshing:\n${known.map(line).join('\n')}`);
            return out.join('\n');
        } catch (e) {
            console.error(e);
            return `Failed to ingest vinyl: ${e.message}`;
        }
    }

    /** One crate row as the model reads it, with when it was added. */
    _line(v, now) {
        const trackCount = Array.isArray(v.tracks) ? v.tracks.length : 0;
        const genre = v.meta?.genre || '';
        const added = addedLabel(v.created_at, now);
        return `- **${v.artist}** — ${v.title} (${v.label || 'Unknown Label'}) [${trackCount} tracks${genre ? ', ' + genre : ''}] (id: ${v.id}${added ? ', ' + added : ''})`;
    }

    async list_vinyls({ limit, offset } = {}) {
        try {
            const vinyls = this.djService.db.getVinyls({ limit: limit || 50, offset: offset || 0 });
            if (vinyls.length === 0) return "Your vinyl crate is empty. Use add_vinyl to scan some records.";

            const now = Date.now();
            const list = vinyls.map(v => this._line(v, now)).join('\n');
            return `Found ${vinyls.length} vinyls in your crate:\n${list}`;
        } catch (e) {
            return `Error listing vinyls: ${e.message}`;
        }
    }

    async get_vinyl({ id }) {
        try {
            const v = this.djService.db.getVinyl(id);
            if (!v) return `Vinyl with id "${id}" not found.`;

            const tracks = (v.tracks || []).map(t =>
                `  ${t.position}: ${t.title}${t.bpm ? ' [' + t.bpm + ' BPM' : ''}${t.key ? ', ' + t.key : ''}${t.bpm ? ']' : ''}`
            ).join('\n');

            return `**${v.artist}** — ${v.title}\nLabel: ${v.label || 'N/A'} | Cat#: ${v.catalog_number || 'N/A'}\nGenre: ${v.meta?.genre || 'N/A'} | Style: ${v.meta?.style || 'N/A'} | Year: ${v.meta?.year || 'N/A'}\nTracks:\n${tracks}`;
        } catch (e) {
            return `Error getting vinyl: ${e.message}`;
        }
    }

    /**
     * One query, or a list with one entry per record, in one call. A cart of
     * twelve records used to take twelve calls, and the tool-loop guard
     * warned the model to stop halfway.
     */
    async search_vinyls({ query, queries } = {}) {
        // A list may arrive as `queries`, as one string in `queries`, or as
        // one `query` with a record per line. All read as a list.
        const given = Array.isArray(queries) ? queries : (typeof queries === 'string' ? [queries] : []);
        const wanted = (given.length > 0 ? given : [query])
            .flatMap(q => String(q ?? '').split(/\r?\n/))
            .map(q => q.trim()).filter(Boolean);
        if (wanted.length === 0) return "Give a query, or a list of queries with one entry per record.";
        const list = wanted.slice(0, MAX_SEARCH_QUERIES);
        try {
            const now = Date.now();
            const sections = [];
            let hits = 0;
            for (const q of list) {
                const vinyls = this.djService.db.searchVinyls(q);
                if (vinyls.length === 0) { sections.push(`"${q}": no match`); continue; }
                hits += 1;
                sections.push(`"${q}": ${vinyls.length} match${vinyls.length === 1 ? '' : 'es'}\n${vinyls.map(v => this._line(v, now)).join('\n')}`);
            }
            const head = list.length > 1 ? `${list.length} searches, ${hits} with a match, ${list.length - hits} with none.` : null;
            const tail = wanted.length > list.length ? `${wanted.length - list.length} more queries were dropped: at most ${MAX_SEARCH_QUERIES} per call.` : null;
            return [head, ...sections, tail].filter(Boolean).join('\n');
        } catch (e) {
            return `Error searching vinyls: ${e.message}`;
        }
    }

    async list_crate_tracks() {
        try {
            const vinyls = this.djService.db.getVinyls({ limit: 200 });
            if (vinyls.length === 0) return "Your vinyl crate is empty. Use add_vinyl to scan some records.";

            const allTracks = [];
            for (const v of vinyls) {
                if (!v.tracks || v.tracks.length === 0) continue;
                for (const t of v.tracks) {
                    allTracks.push({
                        artist: v.artist,
                        vinyl: v.title,
                        position: t.position,
                        title: t.title,
                        bpm: t.bpm || null,
                        key: t.key || null,
                        genre: v.meta?.genre || null,
                        style: v.meta?.style || null,
                        speed: v.meta?.rpm || null,
                    });
                }
            }

            if (allTracks.length === 0) return "No tracks found in your vinyl crate. Records may not have track data yet.";

            const list = allTracks.map(t =>
                `- ${t.artist} — ${t.title} [${t.vinyl}] (${t.position}) ${t.bpm ? '[' + t.bpm + ' BPM' : ''}${t.key ? ', ' + t.key : ''}${t.bpm ? ']' : ''}${t.speed ? ' ' + t.speed + 'RPM' : ''} ${t.genre || ''}`
            ).join('\n');

            return `${allTracks.length} tracks available in your crate:\n${list}`;
        } catch (e) {
            return `Error listing tracks: ${e.message}`;
        }
    }

    async recommend_vinyl({ current_track }) {
        try {
            // ToolExecutor calls executor[toolName](args) — chatId not available here
            // TODO: Pass chatId from ToolExecutor for proper token logging

            const recommendation = await this.djService.recommendVinyl(current_track, 'system_tool_call');
            return recommendation;
        } catch (e) {
            return `Error getting recommendation: ${e.message}`;
        }
    }

    async ingest_dj_history({ content, venue, date, party }) {
        if (this.djService.disabled) {
            return 'DJ history is disabled because DISCOGS_TOKEN is not configured.';
        }
        try {
            const filename = await this.djService.ingestHistory(content, { venue, date, party });
            return `History saved to DJ Vault as \`${filename}\` with context: ${venue} / ${party} (${date}).`;
        } catch (e) {
            return `Failed to save history: ${e.message}`;
        }
    }

    async recommend_digital({ current_track, context }) {
        try {
            const result = await this.djService.recommendDigital(current_track, { context }, 'system_tool_call');
            return result;
        } catch (e) {
            return `Error: ${e.message}`;
        }
    }
}

module.exports = { DJExecutor, addedLabel, imagePartsOf, MAX_SEARCH_QUERIES };
