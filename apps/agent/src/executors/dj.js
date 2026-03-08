const { createAssistantMessage } = require('@deedee/shared/src/types');

class DJExecutor {
    constructor(services) {
        this.services = services;
        this.djService = services.dj;
    }

    async execute(name, args) {
        switch (name) {
            case 'add_vinyl':
                return this.add_vinyl(args);
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

    async add_vinyl({ image_path }) {
        if (!image_path) return "Please provide an image of the vinyl or receipt.";

        try {
            const results = await this.djService.ingestVinyl(image_path, 'auto');
            if (results.length === 0) return "No vinyls detected or confidence too low.";

            const list = results.map(v => `- **${v.artist}** - ${v.title} (${v.label})`).join('\n');
            return `Added ${results.length} vinyls to your crate:\n${list}`;
        } catch (e) {
            console.error(e);
            return `Failed to ingest vinyl: ${e.message}`;
        }
    }

    async list_vinyls({ limit, offset } = {}) {
        try {
            const vinyls = this.djService.db.getVinyls({ limit: limit || 50, offset: offset || 0 });
            if (vinyls.length === 0) return "Your vinyl crate is empty. Use add_vinyl to scan some records.";

            const list = vinyls.map(v => {
                const trackCount = v.tracks ? v.tracks.length : 0;
                const genre = v.meta?.genre || '';
                return `- **${v.artist}** — ${v.title} (${v.label || 'Unknown Label'}) [${trackCount} tracks${genre ? ', ' + genre : ''}] (id: ${v.id})`;
            }).join('\n');
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

    async search_vinyls({ query }) {
        try {
            const vinyls = this.djService.db.searchVinyls(query);
            if (vinyls.length === 0) return `No vinyls found matching "${query}".`;

            const list = vinyls.map(v => {
                const trackCount = v.tracks ? v.tracks.length : 0;
                return `- **${v.artist}** — ${v.title} (${v.label || 'Unknown Label'}) [${trackCount} tracks] (id: ${v.id})`;
            }).join('\n');
            return `Found ${vinyls.length} vinyls matching "${query}":\n${list}`;
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

module.exports = { DJExecutor };
