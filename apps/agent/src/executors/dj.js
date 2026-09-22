const fs = require('fs');
const path = require('path');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { looksLikeBase64, PHOTO_MAX_AGE_MS } = require('../utils/photo-from-chat');

// At most this many searches in one search_vinyls call, and at most this
// many hits shown per search: fifty searches that each hit a shared label
// blew past the 50,000-character result cap.
const MAX_SEARCH_QUERIES = 50;
const MAX_HITS_PER_QUERY = 10;
// At most this many photos read by one add_vinyl call. Each record found
// starts its own enrichment pipeline on the device.
const MAX_PHOTOS_PER_CALL = 5;
// Rows to read when looking back in the chat for the owner's photo.
const PHOTO_LOOKBACK_ROWS = 8;
// image_path may only name an image file under the data folder. The file
// tools resolve every path and stay inside the repo; this tool sent any
// readable file's bytes to the vision model, credentials included.
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

const NO_PHOTO_TEXT = "No photo to read: nothing was added. The owner sends the photo of the cover, label or receipt in this chat with the ask (the latest one within 30 minutes counts); or pass image_path to an image file under the data folder.";

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

/** The photos on a message: image parts with real bytes, not a stripped marker. */
function imagePartsOf(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts.filter(p => p?.inlineData && String(p.inlineData.mimeType || '').toLowerCase().startsWith('image/')
        && looksLikeBase64(p.inlineData.data));
}

/**
 * The real path of an image file under the data folder, or null. A symlink
 * that leaves the folder, a file that is not an image, or a missing file
 * gives null.
 */
function imagePathInData(imagePath, dataDir = process.env.DATA_DIR || '/app/data') {
    if (typeof imagePath !== 'string' || !IMAGE_FILE.test(imagePath)) return null;
    let root, real;
    try {
        root = fs.realpathSync(dataDir);
        real = fs.realpathSync(imagePath);
    } catch {
        return null;
    }
    return real.startsWith(root + path.sep) ? real : null;
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
     * The photos an add_vinyl call with no image_path reads: those on the
     * owner's current message, else the latest photo the owner sent in this
     * chat within 30 minutes (he often sends the photo first and the ask a
     * moment later). Only the owner's own chat counts (context.ownerTyped,
     * from Agent._ownerTyped): a contact's photo, a group's or a watcher's
     * would fill his crate. Returns { photos, fromEarlier }.
     */
    _photosForAdd(context, now) {
        if (context.ownerTyped !== true) return { photos: [], fromEarlier: false };
        const onMessage = imagePartsOf(context.message).map(p => ({ data: p.inlineData.data, mimeType: p.inlineData.mimeType }));
        if (onMessage.length > 0) return { photos: onMessage.slice(0, MAX_PHOTOS_PER_CALL), fromEarlier: false };
        const chatId = context.message?.metadata?.chatId;
        const db = this.services?.db || this.djService?.db;
        if (!chatId || !db || typeof db.getLastUserPhoto !== 'function') return { photos: [], fromEarlier: false };
        try {
            const found = db.getLastUserPhoto(chatId, { since: new Date(now - PHOTO_MAX_AGE_MS).toISOString(), rows: PHOTO_LOOKBACK_ROWS });
            if (found) return { photos: [{ data: found.data, mimeType: found.mimeType }], fromEarlier: true };
        } catch (e) {
            console.warn(`[DJExecutor] Could not look for a photo in the chat: ${e.message}`);
        }
        return { photos: [], fromEarlier: false };
    }

    /**
     * With no image_path, the photo comes from the owner's chat (see
     * _photosForAdd). Before, the tool could not see a chat photo at all, so
     * a background step wrote the crate instead, ask or no ask.
     */
    async add_vinyl({ image_path } = {}, context = {}) {
        try {
            let results;
            let fromEarlier = false;
            if (image_path) {
                const real = imagePathInData(image_path);
                if (!real) return "image_path must name an image file (.jpg, .png, .webp) under the data folder: nothing was added. Leave it out to read the photo in the chat.";
                results = await this.djService.ingestVinyl(real, 'auto');
            } else {
                const chosen = this._photosForAdd(context, Date.now());
                if (chosen.photos.length === 0) return NO_PHOTO_TEXT;
                fromEarlier = chosen.fromEarlier;
                results = [];
                const failures = [];
                for (const photo of chosen.photos) {
                    try {
                        results.push(...(await this.djService.ingestVinylFromBase64(photo.data, photo.mimeType)));
                    } catch (e) {
                        failures.push(e.message);
                    }
                }
                if (results.length === 0 && failures.length > 0) return `Failed to ingest vinyl: ${failures.join('; ')}`;
                if (failures.length > 0) console.warn(`[DJExecutor] add_vinyl: ${failures.length} of ${chosen.photos.length} photos could not be read: ${failures.join('; ')}`);
            }
            if (!results || results.length === 0) return "No vinyls detected or confidence too low.";

            const line = v => `- **${v.artist}** - ${v.title} (${v.label})`;
            const added = results.filter(v => !v._preExisting);
            const known = results.filter(v => v._preExisting);
            const source = fromEarlier ? ' from the photo sent earlier in this chat' : '';
            const out = [];
            if (added.length > 0) out.push(`Added ${added.length} vinyls to your crate${source} (details still loading):\n${added.map(line).join('\n')}`);
            if (known.length > 0) out.push(`Already in the crate${source}, details refreshing:\n${known.map(line).join('\n')}`);
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
     * The queries a search_vinyls call asks for, as a list. `queries` may be
     * an array, one string, or a JSON array in a string; `query` may hold a
     * record per line. `query` and `queries` both count: a model that fills
     * both used to lose the first record of a cart check.
     */
    static queriesOf({ query, queries } = {}) {
        let given = [];
        if (Array.isArray(queries)) given = queries;
        else if (typeof queries === 'string') {
            const t = queries.trim();
            let parsed = null;
            if (t.startsWith('[')) { try { parsed = JSON.parse(t); } catch { parsed = null; } }
            given = Array.isArray(parsed) ? parsed : [queries];
        }
        return [...given, query]
            .filter(q => typeof q === 'string' || typeof q === 'number')
            .flatMap(q => String(q).split(/\r?\n/))
            .map(q => q.trim()).filter(Boolean);
    }

    /**
     * One search. When the words as typed match nothing, the search runs
     * again without the words that are only numbers: a cart line carries a
     * price, a year or a size that no field holds, and the miss then read as
     * "not in the crate" for a record that was.
     */
    _searchOne(q) {
        const db = this.djService.db;
        const exact = db.searchVinyls(q);
        if (exact.length > 0) return { vinyls: exact, near: false };
        const words = q.split(/\s+/).filter(Boolean);
        const lettered = words.filter(w => /\p{L}/u.test(w));
        if (lettered.length > 0 && lettered.length < words.length) {
            const near = db.searchVinyls(lettered.join(' '));
            if (near.length > 0) return { vinyls: near, near: true };
        }
        return { vinyls: [], near: false };
    }

    /**
     * One query, or a list with one entry per record, in one call. A cart of
     * twelve records used to take twelve calls, and the tool-loop guard
     * warned the model to stop halfway.
     */
    async search_vinyls(args = {}) {
        const wanted = DJExecutor.queriesOf(args);
        if (wanted.length === 0) return "Give a query, or a list of queries with one entry per record.";
        const list = wanted.slice(0, MAX_SEARCH_QUERIES);
        try {
            const now = Date.now();
            const sections = [];
            let hits = 0;
            for (const q of list) {
                const { vinyls, near } = this._searchOne(q);
                if (vinyls.length === 0) { sections.push(`"${q}": no match`); continue; }
                hits += 1;
                const shown = vinyls.slice(0, MAX_HITS_PER_QUERY);
                const count = `${vinyls.length} ${near ? 'near ' : ''}match${vinyls.length === 1 ? '' : 'es'}${near ? ' with the numbers left out; compare the titles' : ''}`;
                const more = vinyls.length > shown.length ? `\n  (${vinyls.length - shown.length} more not shown; search with more words)` : '';
                sections.push(`"${q}": ${count}\n${shown.map(v => this._line(v, now)).join('\n')}${more}`);
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

module.exports = { DJExecutor, addedLabel, imagePartsOf, imagePathInData, NO_PHOTO_TEXT, MAX_SEARCH_QUERIES, MAX_HITS_PER_QUERY, MAX_PHOTOS_PER_CALL };
