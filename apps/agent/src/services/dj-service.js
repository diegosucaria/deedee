const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { ConfigService } = require('./config-service');

class DJService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
        this.vaults = agent.vaults;
        this.config = new ConfigService();
        this.mcp = agent.mcp; // Access to MCP tools if needed, or we use agent's toolExecutor logic? 
        // We can use agent.client (Gemini) directly for intelligence?
        // agent.toolExecutor.services.client is populated at runtime, but we might want direct access if passed in constructor?
        // In agent.js: `this.mcp = new MCPManager(); ... this.gsuite = new GSuiteService(this);`
        // So `this.agent` is available.
    }

    async initialize() {
        // Ensure 'dj_history' vault exists
        const vaultId = 'dj_history';
        const vaultPath = path.join(this.vaults.vaultsDir, vaultId);

        if (!fs.existsSync(vaultPath)) {
            console.log('[DJService] Creating dj_history vault...');
            await this.vaults.createVault('dj_history');
            // Initialize with a README
            await this.vaults.updateVaultPage(vaultId, 'index.md', '# DJ History\n\nStore your playlist histories here with YAML frontmatter metadata.');
        }
    }

    /**
     * Ingest a Vinyl from an Image (Cover or Receipt)
     * @param {string} imageUrl - URL, Local Path, or Base64
     * @param {string} type - 'auto', 'cover', 'receipt'
     */
    async ingestVinyl(imageInput, type = 'auto') {
        console.log(`[DJService] Ingesting Vinyl from image... Type: ${type}`);
        if (!this.agent.client) throw new Error('Gemini Client not initialized');

        const imagePart = await this._prepareImagePart(imageInput);
        const imageSource = typeof imageInput === 'string' && imageInput.startsWith('/') ? imageInput : null;
        return this._analyzeAndIngest(imagePart, imageSource);
    }

    /**
     * Ingest from base64 data (used by analysis-service and web upload).
     */
    async ingestVinylFromBase64(base64Data, mimeType = 'image/jpeg') {
        console.log('[DJService] Ingesting Vinyl from base64 data...');
        if (!this.agent.client) throw new Error('Gemini Client not initialized');

        const imagePart = { inlineData: { data: base64Data, mimeType } };
        return this._analyzeAndIngest(imagePart, { base64: base64Data, mimeType });
    }

    /**
     * Shared analysis pipeline for both file and base64 inputs.
     */
    async _analyzeAndIngest(imagePart, imageSource = null) {
        const modelName = this.config.getModel('FLASH');

        const prompt = `
      Analyze this image for a DJ Vinyl Collection.
      It could be a **Vinyl Cover** (Artist, Title, Label, Cat#) OR a **Receipt/List** (List of records).
      
      If it is a RECEIPT/LIST:
      Return a JSON object with:
      {
        "type": "receipt",
        "items": [
           { "artist": "...", "title": "...", "label": "...", "confidence": 0.9 }
        ]
      }
      
      If it is a COVER/CENTER LABEL:
      Return a JSON object with:
      {
        "type": "cover",
        "artist": "...",
        "title": "...",
        "label": "...",
        "catalog_number": "...",
        "tracklist": ["Track A1", "Track B1"...] (if visible)
      }
      
      Respond ONLY with JSON.
    `;

        const result = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{
                role: 'user',
                parts: [imagePart, { text: prompt }]
            }],
            config: {
                responseMimeType: 'application/json'
            }
        });

        let responseText = '';
        try {
            if (typeof result.text === 'function') responseText = result.text();
            else if (result.text) responseText = result.text;
            else if (result.candidates?.[0]?.content?.parts) {
                responseText = result.candidates[0].content.parts.map(p => p.text).join('');
            }
        } catch (e) { /* ignore */ }

        let data;
        try {
            const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            data = JSON.parse(jsonStr);
        } catch (e) {
            console.error('[DJService] Failed to parse Vision JSON:', responseText);
            throw new Error('Failed to parse vinyl information from image.');
        }

        const ingested = [];
        if (data.type === 'receipt') {
            for (const item of data.items) {
                if (item.confidence > 0.6) {
                    const placeholder = await this._createPlaceholder(item, imageSource);
                    this._runEnrichmentPipeline(placeholder.id, item, placeholder.coverUrl)
                        .catch(err => console.error(`[DJService] Background enrichment failed for ${placeholder.id}:`, err.message));
                    ingested.push(placeholder);
                }
            }
        } else {
            const placeholder = await this._createPlaceholder(data, imageSource);
            this._runEnrichmentPipeline(placeholder.id, data, placeholder.coverUrl)
                .catch(err => console.error(`[DJService] Background enrichment failed for ${placeholder.id}:`, err.message));
            ingested.push(placeholder);
        }

        return ingested;
    }

    /**
     * Create a placeholder vinyl record and return immediately.
     * Saves the uploaded image, checks for duplicates, inserts a row with enrichment_status='enriching'.
     */
    async _createPlaceholder(rawItem, imageSource = null) {
        console.log(`[DJService] Creating placeholder for: ${rawItem.artist} - ${rawItem.title}`);

        // 1. Save uploaded photo as initial cover
        let coverUrl = '/vinyl_covers/default.png';
        const dataDir = path.join(process.env.DATA_DIR || '/app/data', 'vinyl_covers');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        if (imageSource) {
            const filename = `${crypto.randomUUID()}.jpg`;
            const filePath = path.join(dataDir, filename);

            if (typeof imageSource === 'string' && imageSource.startsWith('/')) {
                fs.copyFileSync(imageSource, filePath);
                coverUrl = `/vinyl_covers/${filename}`;
            } else if (imageSource.base64) {
                fs.writeFileSync(filePath, Buffer.from(imageSource.base64, 'base64'));
                coverUrl = `/vinyl_covers/${filename}`;
            }
        }

        // 2. Duplicate detection — if exists, mark it as re-enriching
        const existing = this.db.findVinylByArtistTitle(rawItem.artist, rawItem.title);
        if (existing) {
            console.log(`[DJService] Duplicate found: "${rawItem.artist} - ${rawItem.title}" (id: ${existing.id}). Will re-enrich.`);
            this.db.updateVinyl(existing.id, { enrichment_status: 'enriching' });
            if (this.agent.interface && this.agent.interface.broadcast) {
                this.agent.interface.broadcast('dj:vinyl:enriching', {
                    id: existing.id, artist: rawItem.artist, title: rawItem.title, status: 'enriching'
                });
            }
            return { ...existing, enrichment_status: 'enriching', coverUrl, _preExisting: true };
        }

        // 3. Insert placeholder row
        const vinyl = {
            artist: rawItem.artist || '',
            title: rawItem.title || '',
            label: rawItem.label || '',
            catalogNumber: rawItem.catalog_number || '',
            coverImageUrl: coverUrl,
            bpm: 0,
            key: '',
            tracks: [],
            meta: { source: 'vision', enrichmentConfidence: 0 },
            enrichmentStatus: 'enriching'
        };

        const id = this.db.addVinyl(vinyl);

        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:enriching', {
                id, artist: rawItem.artist, title: rawItem.title, status: 'enriching'
            });
            this.agent.interface.broadcast('dj:vinyl:update', { ...vinyl, id, enrichment_status: 'enriching' });
        }

        return { ...vinyl, id, enrichment_status: 'enriching', coverUrl };
    }

    /**
     * Run the full enrichment pipeline in the background for a vinyl ID.
     * On success: updates vinyl with enriched data and sets enrichment_status='complete'.
     * On failure: sets enrichment_status='failed' and broadcasts.
     */
    async _runEnrichmentPipeline(vinylId, rawItem, initialCoverUrl) {
        console.log(`[DJService] Starting enrichment pipeline for: ${rawItem.artist} - ${rawItem.title} (${vinylId})`);
        let coverUrl = initialCoverUrl || '/vinyl_covers/default.png';

        try {
            // 1. Cascading metadata enrichment: Discogs → MusicBrainz → Gemini
            let enriched = {};
            try {
                enriched = await this._cascadeEnrich(rawItem.artist, rawItem.title, rawItem.label, rawItem.catalog_number);
                console.log(`[DJService] Enrichment complete for ${vinylId}. Keys: ${Object.keys(enriched).join(', ')}`);
            } catch (e) {
                console.error('[DJService] Metadata enrichment failed:', e.message);
            }

            // 2. Try to download cover art
            const candidateUrls = enriched._coverArtUrls || (enriched.coverArtUrl ? [enriched.coverArtUrl] : []);
            if (candidateUrls.length > 0) {
                const downloadedCover = await this._downloadCoverArt(candidateUrls);
                if (downloadedCover) coverUrl = downloadedCover;
            }

            // 3. Build enriched vinyl data
            const tracks = this._normalizeTracks(rawItem.tracklist, enriched.tracks);
            const meta = {
                source: 'vision',
                genre: enriched.genre || '',
                year: enriched.year || '',
                rpm: enriched.rpm || 0,
                discogsUrl: enriched.discogsUrl || '',
                beatportUrl: enriched.beatportUrl || '',
                style: enriched.style || '',
                enrichmentConfidence: enriched.confidence || 0,
                ...(initialCoverUrl && initialCoverUrl !== '/vinyl_covers/default.png' && initialCoverUrl !== coverUrl ? { originalCoverUrl: initialCoverUrl } : {})
            };

            // 4. Per-track BPM/key cross-reference
            let finalTracks = tracks;
            if (tracks.length > 0 && tracks.length <= 8) {
                try {
                    finalTracks = await this._enrichTrackDetails(rawItem.artist, tracks);
                } catch (e) {
                    console.warn('[DJService] Per-track enrichment failed:', e.message);
                }
            }

            // 5. Hidden Gems: fetch price guide + generate history (parallel, non-fatal)
            const discogsReleaseId = (enriched.discogsUrl || '').match(/\/release\/(\d+)/)?.[1] || null;
            const [priceGuide, history] = await Promise.allSettled([
                discogsReleaseId ? this._fetchPriceGuide(discogsReleaseId) : Promise.resolve(null),
                this._generateHistory(rawItem.artist, rawItem.title, enriched.label || rawItem.label, enriched.year)
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

            // 6. Check if this was a duplicate (pre-existing vinyl)
            const currentVinyl = this.db.getVinyl(vinylId);
            const isPreExisting = currentVinyl && currentVinyl.created_at && currentVinyl.tracks?.length > 0;

            const enrichedMeta = {
                ...meta,
                ...(priceGuide ? { priceGuide } : {}),
                ...(history ? { history } : {})
            };

            const updateFields = {
                label: rawItem.label || enriched.label || currentVinyl?.label || '',
                catalog_number: rawItem.catalog_number || enriched.catalogNumber || currentVinyl?.catalog_number || '',
                cover_image_url: coverUrl !== '/vinyl_covers/default.png' ? coverUrl : (currentVinyl?.cover_image_url || coverUrl),
                tracks: finalTracks.length > 0 ? finalTracks : (currentVinyl?.tracks || []),
                meta: isPreExisting ? {
                    ...(currentVinyl.meta || {}),
                    ...enrichedMeta,
                    enrichmentConfidence: Math.max(enrichedMeta.enrichmentConfidence || 0, currentVinyl.meta?.enrichmentConfidence || 0)
                } : enrichedMeta,
                enrichment_status: 'complete'
            };

            this.db.updateVinyl(vinylId, updateFields);
            const updated = this.db.getVinyl(vinylId);

            if (this.agent.interface && this.agent.interface.broadcast) {
                this.agent.interface.broadcast('dj:vinyl:update', updated);
            }

            console.log(`[DJService] Enrichment pipeline complete for: ${rawItem.artist} - ${rawItem.title} (${vinylId})`);
            return updated;
        } catch (error) {
            console.error(`[DJService] Enrichment pipeline failed for ${vinylId}:`, error.message);
            try {
                this.db.updateVinyl(vinylId, { enrichment_status: 'failed' });
                const failed = this.db.getVinyl(vinylId);
                if (this.agent.interface && this.agent.interface.broadcast) {
                    this.agent.interface.broadcast('dj:vinyl:update', failed);
                }
            } catch (e) {
                console.error(`[DJService] Failed to update status for ${vinylId}:`, e.message);
            }
            throw error;
        }
    }

    /**
     * Retry enrichment for a failed vinyl — sets status to 'enriching' and runs pipeline in background.
     */
    async retryEnrich(vinylId) {
        const vinyl = this.db.getVinyl(vinylId);
        if (!vinyl) throw new Error(`Vinyl ${vinylId} not found`);

        this.db.updateVinyl(vinylId, { enrichment_status: 'enriching' });
        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:enriching', {
                id: vinylId, artist: vinyl.artist, title: vinyl.title, status: 'enriching'
            });
            this.agent.interface.broadcast('dj:vinyl:update', { ...vinyl, enrichment_status: 'enriching' });
        }

        const rawItem = { artist: vinyl.artist, title: vinyl.title, label: vinyl.label, catalog_number: vinyl.catalog_number };
        this._runEnrichmentPipeline(vinylId, rawItem, vinyl.cover_image_url)
            .catch(err => console.error(`[DJService] Retry enrichment failed for ${vinylId}:`, err.message));

        return { success: true, status: 'enriching' };
    }

    /**
     * Re-enrich an existing vinyl by ID — re-runs metadata + per-track search.
     */
    async reEnrich(vinylId) {
        const vinyl = this.db.getVinyl(vinylId);
        if (!vinyl) throw new Error(`Vinyl ${vinylId} not found`);

        console.log(`[DJService] Re-enriching: ${vinyl.artist} - ${vinyl.title}`);

        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:enriching', {
                id: vinylId, artist: vinyl.artist, title: vinyl.title, status: 'enriching'
            });
        }

        let enriched = {};
        try {
            enriched = await this._cascadeEnrich(vinyl.artist, vinyl.title, vinyl.label, vinyl.catalog_number);
        } catch (e) {
            console.warn('[DJService] Re-enrichment metadata failed:', e.message);
        }

        let tracks = this._normalizeTracks(null, enriched.tracks || []);
        // Fallback to existing tracks if enrichment returned none
        if (tracks.length === 0) {
            tracks = typeof vinyl.tracks === 'string' ? JSON.parse(vinyl.tracks) : vinyl.tracks;
        }

        // Per-track cross-reference
        if (tracks.length > 0 && tracks.length <= 8) {
            try {
                tracks = await this._enrichTrackDetails(vinyl.artist, tracks);
            } catch (e) {
                console.warn('[DJService] Per-track re-enrichment failed:', e.message);
            }
        }

        const existingMeta = typeof vinyl.meta === 'string' ? JSON.parse(vinyl.meta) : (vinyl.meta || {});

        // Hidden Gems: fetch price guide + generate history (parallel, non-fatal)
        const discogsReleaseId = (enriched.discogsUrl || existingMeta.discogsUrl || '').match(/\/release\/(\d+)/)?.[1] || null;
        const [priceGuide, history] = await Promise.allSettled([
            discogsReleaseId ? this._fetchPriceGuide(discogsReleaseId) : Promise.resolve(null),
            this._generateHistory(vinyl.artist, vinyl.title, enriched.label || vinyl.label, enriched.year || existingMeta.year)
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

        const updateFields = {
            label: enriched.label || vinyl.label,
            catalog_number: enriched.catalogNumber || vinyl.catalog_number,
            tracks,
            meta: {
                ...existingMeta,
                genre: enriched.genre || existingMeta.genre || '',
                style: enriched.style || existingMeta.style || '',
                year: enriched.year || existingMeta.year || '',
                rpm: enriched.rpm || existingMeta.rpm || 0,
                discogsUrl: enriched.discogsUrl || '',
                beatportUrl: enriched.beatportUrl || '',
                enrichmentConfidence: enriched.confidence || 0,
                ...(priceGuide ? { priceGuide } : (existingMeta.priceGuide ? { priceGuide: existingMeta.priceGuide } : {})),
                ...(history ? { history } : (existingMeta.history ? { history: existingMeta.history } : {})),
                lastEnriched: new Date().toISOString()
            }
        };

        // Preserve original photo URL if not already saved
        if (!updateFields.meta.originalCoverUrl && !existingMeta?.originalCoverUrl && vinyl.cover_image_url && vinyl.cover_image_url !== '/vinyl_covers/default.png') {
            updateFields.meta.originalCoverUrl = vinyl.cover_image_url;
        } else if (existingMeta?.originalCoverUrl) {
            updateFields.meta.originalCoverUrl = existingMeta.originalCoverUrl;
        }

        // Try to download cover if we got a better one (with redirect support)
        const candidateUrls = enriched._coverArtUrls || (enriched.coverArtUrl ? [enriched.coverArtUrl] : []);
        if (candidateUrls.length > 0) {
            const downloadedCover = await this._downloadCoverArt(candidateUrls);
            if (downloadedCover) {
                updateFields.cover_image_url = downloadedCover;
            }
        }

        this.db.updateVinyl(vinylId, updateFields);
        const updated = this.db.getVinyl(vinylId);

        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:update', updated);
        }

        console.log(`[DJService] Re-enrichment complete for: ${vinyl.artist} - ${vinyl.title}`);
        return updated;
    }

    /**
     * Enrich vinyl metadata using Google Search grounding.
     * Looks up BPM, key, genre, year from Discogs/Beatport.
     */
    async _enrichMetadata(artist, title, label) {
        if (!artist && !title) return {};

        const modelName = this.config.getModel('FLASH');
        const query = `${artist || ''} - ${title || ''} ${label ? `(${label})` : ''}`;
        console.log(`[DJService] Enriching metadata for: ${query} (model: ${modelName})`);

        try {
            const startTime = Date.now();
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [{
                        text: `Look up this vinyl record: "${query}". Search Discogs, Beatport, decks.de, and juno.co.uk.
Return JSON with:
{
  "genre": "string",
  "style": "string (subgenre)",
  "year": number,
  "rpm": number (vinyl RPM speed: 33, 45, or 78),
  "tracks": [
    { "position": "A1", "title": "Track Name", "bpm": number, "key": "string in Camelot notation (e.g. 8A, 11B, 1A)" }
  ],
  "discogsUrl": "URL or empty",
  "beatportUrl": "URL or empty",
  "coverArtUrl": "Direct image URL of the vinyl cover from Discogs or empty",
  "label": "string",
  "catalogNumber": "string",
  "confidence": number between 0 and 1 indicating how confident you are that this is the correct record
}
IMPORTANT RULES:
- BPM and key are PER TRACK, not per vinyl. Each track must have its own BPM and key.
- Use CAMELOT key notation (1A through 12B), NOT traditional notation (Am, Cm, etc.).
- If you only know the traditional key (e.g. Am, Cm), still convert to Camelot.
- RPM is the vinyl playback speed (33 for LP, 45 for single/EP, 78 for shellac).
- If you cannot find exact data, provide your best estimate and set confidence accordingly.
Respond ONLY with valid JSON.` }]
                }],
                config: {
                    tools: [{ googleSearch: {} }]
                }
            });

            const elapsed = Date.now() - startTime;
            console.log(`[DJService] Gemini search+enrichment call took ${elapsed}ms`);

            let text = '';
            try {
                if (typeof result.text === 'function') text = result.text();
                else if (result.text) text = result.text;
                else if (result.candidates?.[0]?.content?.parts) {
                    text = result.candidates[0].content.parts.map(p => p.text).filter(Boolean).join('');
                }
            } catch (e) {
                console.warn('[DJService] Failed to extract text from result:', e.message);
            }

            if (!text) {
                console.warn('[DJService] Empty response from enrichment. Result keys:', Object.keys(result || {}));
                if (result?.candidates?.[0]) {
                    console.warn('[DJService] Candidate finish reason:', result.candidates[0].finishReason);
                }
                return {};
            }

            console.log(`[DJService] Raw enrichment response (${text.length} chars): ${text.substring(0, 200)}...`);

            try {
                const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
                const data = JSON.parse(cleaned);
                console.log(`[DJService] Enriched: Genre=${data.genre}, Style=${data.style}, Year=${data.year}, RPM=${data.rpm}, Tracks=${data.tracks?.length || 0}, Confidence=${data.confidence}`);
                if (data.tracks?.length > 0) {
                    data.tracks.forEach(t => console.log(`[DJService]   Track: ${t.position} ${t.title} | BPM: ${t.bpm} | Key: ${t.key}`));
                }
                return data;
            } catch (parseErr) {
                console.error(`[DJService] JSON parse failed: ${parseErr.message}. Raw text: ${text.substring(0, 500)}`);
                return {};
            }
        } catch (e) {
            console.error('[DJService] Search enrichment failed:', e.message);
            if (e.response) console.error('[DJService] API error details:', JSON.stringify(e.response.data || e.response).substring(0, 500));
        }

        return {};
    }

    /**
     * Normalize tracks: merge vision-extracted strings with enriched objects.
     * Output: [{ position, title, bpm, key }]
     */
    _normalizeTracks(visionTracks, enrichedTracks) {
        const normalize = (t, i) => {
            if (typeof t === 'string') {
                return { position: `${i + 1}`, title: t, bpm: 0, key: '' };
            }
            // Convert standard key to Camelot if not already Camelot
            const track = { ...t };
            if (track.key && !this._isCamelot(track.key)) {
                const camelot = this._toCamelot(track.key);
                if (camelot) {
                    console.log(`[DJService] Converted key: ${track.key} → ${camelot}`);
                    track.key = camelot;
                }
            }
            return track;
        };

        // Prefer enriched (structured objects with bpm/key)
        if (enrichedTracks && Array.isArray(enrichedTracks) && enrichedTracks.length > 0) {
            return enrichedTracks.map(normalize);
        }
        // Fall back to vision strings
        if (visionTracks && Array.isArray(visionTracks) && visionTracks.length > 0) {
            return visionTracks.map(normalize);
        }
        return [];
    }

    // ─── Multi-Source Enrichment Pipeline ─────────────────────────────────

    /** Get Discogs personal access token from env or agent settings */
    _getDiscogsToken() {
        if (process.env.DISCOGS_TOKEN) return process.env.DISCOGS_TOKEN;
        try {
            const setting = this.db.getAgentSetting('discogs_token');
            if (setting?.value) return setting.value;
        } catch (e) { /* ignore */ }
        return null;
    }

    /** MusicBrainz rate limiting: max 1 request per second */
    async _musicBrainzThrottle() {
        const now = Date.now();
        const elapsed = now - (this._lastMBCall || 0);
        if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
        this._lastMBCall = Date.now();
    }

    /**
     * Fetch price guide from Discogs marketplace API.
     * Returns { median, lowest, highest, currency, numForSale, lastChecked } or null.
     */
    async _fetchPriceGuide(releaseId) {
        const token = this._getDiscogsToken();
        if (!token || !releaseId) return null;

        try {
            const resp = await axios.get(
                `https://api.discogs.com/marketplace/price_suggestions/${releaseId}`,
                {
                    headers: {
                        'Authorization': `Discogs token=${token}`,
                        'User-Agent': 'DeeDee/1.0'
                    },
                    timeout: 10000
                }
            );

            const conditions = resp.data;
            const values = Object.values(conditions)
                .map(c => c.value)
                .filter(v => typeof v === 'number' && v > 0);

            if (values.length === 0) return null;

            values.sort((a, b) => a - b);
            return {
                median: parseFloat(values[Math.floor(values.length / 2)].toFixed(2)),
                lowest: parseFloat(Math.min(...values).toFixed(2)),
                highest: parseFloat(Math.max(...values).toFixed(2)),
                currency: Object.values(conditions)[0]?.currency || 'USD',
                numForSale: values.length,
                lastChecked: new Date().toISOString()
            };
        } catch (e) {
            if (e.response?.status !== 404) {
                console.warn(`[DJService] Price guide fetch failed: ${e.message}`);
            }
            return null;
        }
    }

    /**
     * Generate a short history blurb about a vinyl release using Gemini + Google Search grounding.
     */
    async _generateHistory(artist, title, label, year) {
        if (!artist && !title) return null;
        try {
            const modelName = this.config.getModel('FLASH');
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [{
                        text: `Write 2-3 sentences about the vinyl record "${artist || ''} - ${title || ''}"${label ? ` on ${label}` : ''}${year ? ` (${year})` : ''}. Cover: release significance, why it matters in its genre, and any notable context about the artist or label. Be specific and factual. Respond with plain text only, no markdown.`
                    }]
                }],
                config: { tools: [{ googleSearch: {} }] }
            });

            let text = '';
            try {
                if (typeof result.text === 'function') text = result.text();
                else if (result.text) text = result.text;
            } catch (e) { /* ignore */ }

            return text?.trim() || null;
        } catch (e) {
            console.warn(`[DJService] History generation failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Refresh just the price guide and history for a vinyl (no cascade re-enrichment).
     */
    async refreshValue(vinylId) {
        const vinyl = this.db.getVinyl(vinylId);
        if (!vinyl) throw new Error(`Vinyl ${vinylId} not found`);

        const meta = typeof vinyl.meta === 'string' ? JSON.parse(vinyl.meta) : (vinyl.meta || {});
        const discogsReleaseId = meta.discogsUrl
            ? (meta.discogsUrl.match(/\/release\/(\d+)/) || [])[1]
            : null;

        const [priceGuide, history] = await Promise.allSettled([
            discogsReleaseId ? this._fetchPriceGuide(discogsReleaseId) : Promise.resolve(null),
            this._generateHistory(vinyl.artist, vinyl.title, vinyl.label, meta.year)
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

        const updatedMeta = {
            ...meta,
            ...(priceGuide ? { priceGuide } : {}),
            ...(history ? { history } : {}),
            lastEnriched: new Date().toISOString()
        };

        this.db.updateVinyl(vinylId, { meta: updatedMeta });
        const updated = this.db.getVinyl(vinylId);

        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:update', updated);
        }

        return updated;
    }

    /**
     * Score a Discogs search result against expected artist/title/label/catno.
     * Discogs results have title in "Artist - Release Title" format.
     * Returns 0–1 where 1 is a perfect match.
     */
    _scoreDiscogsResult(result, expectedArtist, expectedTitle, expectedLabel, expectedCatno) {
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

        // Split Discogs "Artist - Title" format
        const fullTitle = result.title || '';
        const dashIdx = fullTitle.indexOf(' - ');
        const resultArtist = norm(dashIdx > -1 ? fullTitle.substring(0, dashIdx) : '');
        const resultTitle = norm(dashIdx > -1 ? fullTitle.substring(dashIdx + 3) : fullTitle);
        const resultFull = norm(fullTitle);

        const expArtist = norm(expectedArtist);
        const expTitle = norm(expectedTitle);

        let score = 0;
        let totalWeight = 0;

        // --- Artist match (weight 0.35) ---
        if (expArtist) {
            totalWeight += 0.35;
            if (resultArtist && (resultArtist.includes(expArtist) || expArtist.includes(resultArtist))) {
                score += 0.35;
            } else {
                const artistWords = expArtist.split(' ').filter(w => w.length > 2);
                if (artistWords.length > 0) {
                    const matched = artistWords.filter(w => resultFull.includes(w)).length;
                    score += 0.35 * (matched / artistWords.length);
                }
            }
        }

        // --- Title match (weight 0.35) ---
        if (expTitle) {
            totalWeight += 0.35;
            if (resultTitle && (resultTitle.includes(expTitle) || expTitle.includes(resultTitle))) {
                score += 0.35;
            } else {
                const titleWords = expTitle.split(' ').filter(w => w.length > 2);
                if (titleWords.length > 0) {
                    const matched = titleWords.filter(w => resultFull.includes(w)).length;
                    score += 0.35 * (matched / titleWords.length);
                }
            }
        }

        // --- Label match (weight 0.15) ---
        if (expectedLabel) {
            totalWeight += 0.15;
            const resultLabels = (Array.isArray(result.label) ? result.label : []).map(norm);
            const expLabel = norm(expectedLabel);
            if (resultLabels.some(l => l.includes(expLabel) || expLabel.includes(l))) {
                score += 0.15;
            }
        }

        // --- Catalog number match (weight 0.15) ---
        if (expectedCatno) {
            totalWeight += 0.15;
            const resultCatno = norm(result.catno || '');
            if (resultCatno && resultCatno === norm(expectedCatno)) {
                score += 0.15;
            }
        }

        return totalWeight > 0 ? score / totalWeight : 0;
    }

    /**
     * Search Discogs API for release metadata, tracklist, and cover art.
     * Runs ALL search strategies (catno, artist+title, free-text), scores
     * every candidate, and picks the best match above a minimum threshold.
     */
    async _searchDiscogs(artist, title, label, catalogNumber) {
        const token = this._getDiscogsToken();
        if (!token) {
            console.log('[DJService] No Discogs token configured — skipping Discogs search.');
            return null;
        }

        const headers = {
            'Authorization': `Discogs token=${token}`,
            'User-Agent': 'DeeDee/1.0'
        };

        // Build all search strategies
        const searches = [];
        if (catalogNumber) {
            searches.push({ catno: catalogNumber, type: 'release' });
        }
        if (artist && title) {
            searches.push({ artist, release_title: title, type: 'release' });
        }
        if (artist || title) {
            searches.push({ q: `${artist || ''} ${title || ''}`.trim(), type: 'release' });
        }

        // Collect candidates from ALL strategies instead of stopping at first hit
        const candidates = [];
        const seenIds = new Set();

        for (const params of searches) {
            try {
                console.log(`[DJService] Discogs search: ${JSON.stringify(params)}`);
                const resp = await axios.get('https://api.discogs.com/database/search', {
                    params, headers, timeout: 10000
                });
                if (resp.data?.results?.length > 0) {
                    // Score top 5 results from each strategy
                    for (const result of resp.data.results.slice(0, 5)) {
                        if (seenIds.has(result.id)) continue;
                        seenIds.add(result.id);
                        const score = this._scoreDiscogsResult(result, artist, title, label, catalogNumber);
                        candidates.push({ result, score });
                        console.log(`[DJService] Discogs candidate: ${result.title} (id: ${result.id}, score: ${score.toFixed(2)})`);
                    }
                }
            } catch (e) {
                console.warn(`[DJService] Discogs search failed: ${e.message}`);
            }
        }

        if (candidates.length === 0) {
            console.log('[DJService] Discogs: no results found.');
            return null;
        }

        // Pick best-scoring candidate
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        const MIN_SCORE = 0.3;

        if (best.score < MIN_SCORE) {
            console.log(`[DJService] Discogs: best match "${best.result.title}" scored ${best.score.toFixed(2)} — below threshold ${MIN_SCORE}, rejecting.`);
            return null;
        }

        const releaseId = best.result.id;
        console.log(`[DJService] Discogs search hit: release ${releaseId} (${best.result.title}, score: ${best.score.toFixed(2)})`);
        if (candidates.length > 1) {
            console.log(`[DJService] Discogs runner-up: ${candidates[1].result.title} (id: ${candidates[1].result.id}, score: ${candidates[1].score.toFixed(2)})`);
        }

        // Fetch full release detail
        try {
            const resp = await axios.get(`https://api.discogs.com/releases/${releaseId}`, {
                headers, timeout: 10000
            });
            const r = resp.data;

            // Extract RPM from formats
            let rpm = 0;
            if (r.formats) {
                for (const fmt of r.formats) {
                    const descs = (fmt.descriptions || []).join(' ').toLowerCase();
                    if (descs.includes('45 rpm') || descs.includes('45rpm')) { rpm = 45; break; }
                    if (descs.includes('33 rpm') || descs.includes('33rpm')) { rpm = 33; break; }
                    if (descs.includes('78 rpm') || descs.includes('78rpm')) { rpm = 78; break; }
                    // Also check format name
                    if (fmt.name === '7"' || fmt.name === '10"') rpm = 45;
                    if (fmt.name === '12"' || fmt.name === 'LP') rpm = 33;
                }
            }

            // Collect cover art URLs (ordered by preference)
            const coverArtUrls = [];
            if (r.images?.length > 0) {
                const primary = r.images.find(i => i.type === 'primary');
                if (primary?.uri) coverArtUrls.push(primary.uri);
                // Also add first secondary as fallback
                const secondary = r.images.find(i => i.type === 'secondary');
                if (secondary?.uri) coverArtUrls.push(secondary.uri);
            }
            // Discogs search result thumbnail as last resort
            if (r.thumb) coverArtUrls.push(r.thumb);

            const tracks = (r.tracklist || [])
                .filter(t => t.type_ === 'track')
                .map(t => ({
                    position: t.position || '',
                    title: t.title || '',
                    bpm: 0,
                    key: ''
                }));

            return {
                genre: r.genres?.[0] || '',
                style: r.styles?.[0] || '',
                year: r.year || 0,
                rpm,
                tracks,
                discogsUrl: r.uri || '',
                beatportUrl: '',
                coverArtUrl: coverArtUrls[0] || '',
                _coverArtUrls: coverArtUrls,
                label: r.labels?.[0]?.name || '',
                catalogNumber: r.labels?.[0]?.catno || '',
                confidence: 0.95,
                _source: 'discogs'
            };
        } catch (e) {
            console.warn(`[DJService] Discogs release fetch failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Search MusicBrainz for release metadata and Cover Art Archive for images.
     */
    async _searchMusicBrainz(artist, title, catalogNumber) {
        const headers = {
            'User-Agent': 'DeeDee/1.0 (dj-crate-enrichment)',
            'Accept': 'application/json'
        };

        // Build Lucene query
        let query;
        if (catalogNumber) {
            query = `catno:${catalogNumber}`;
        } else if (artist && title) {
            query = `artist:"${artist}" AND release:"${title}"`;
        } else {
            query = artist || title || '';
        }

        if (!query) return null;

        // Search for release
        let mbid = null;
        try {
            await this._musicBrainzThrottle();
            console.log(`[DJService] MusicBrainz search: ${query}`);
            const resp = await axios.get('https://musicbrainz.org/ws/2/release', {
                params: { query, fmt: 'json', limit: 5 },
                headers, timeout: 10000
            });
            if (resp.data?.releases?.length > 0) {
                mbid = resp.data.releases[0].id;
                console.log(`[DJService] MusicBrainz hit: ${mbid} (${resp.data.releases[0].title})`);
            }
        } catch (e) {
            console.warn(`[DJService] MusicBrainz search failed: ${e.message}`);
            return null;
        }

        if (!mbid) {
            console.log('[DJService] MusicBrainz: no results found.');
            return null;
        }

        // Fetch release detail with recordings
        let tracks = [];
        let releaseData = {};
        try {
            await this._musicBrainzThrottle();
            const resp = await axios.get(`https://musicbrainz.org/ws/2/release/${mbid}`, {
                params: { inc: 'recordings', fmt: 'json' },
                headers, timeout: 10000
            });
            releaseData = resp.data;
            if (releaseData.media) {
                for (const medium of releaseData.media) {
                    const side = medium.position || 1;
                    for (const t of (medium.tracks || [])) {
                        tracks.push({
                            position: `${String.fromCharCode(64 + side)}${t.position || t.number}`,
                            title: t.title || t.recording?.title || '',
                            bpm: 0,
                            key: ''
                        });
                    }
                }
            }
        } catch (e) {
            console.warn(`[DJService] MusicBrainz release detail failed: ${e.message}`);
        }

        // Fetch cover art from Cover Art Archive
        let coverArtUrl = '';
        const coverArtUrls = [];
        try {
            const resp = await axios.get(`https://coverartarchive.org/release/${mbid}`, {
                timeout: 10000, headers: { 'User-Agent': 'DeeDee/1.0' }
            });
            if (resp.data?.images) {
                const front = resp.data.images.find(i => i.front);
                if (front) {
                    coverArtUrl = front.thumbnails?.['500'] || front.thumbnails?.large || front.image || '';
                    if (front.image) coverArtUrls.push(front.image);
                    if (front.thumbnails?.['500']) coverArtUrls.push(front.thumbnails['500']);
                    if (front.thumbnails?.large) coverArtUrls.push(front.thumbnails.large);
                }
            }
        } catch (e) {
            // Cover Art Archive often returns 404 — not all releases have art
            if (e.response?.status !== 404) {
                console.warn(`[DJService] Cover Art Archive failed: ${e.message}`);
            }
        }

        const labelInfo = releaseData['label-info']?.[0];
        return {
            genre: '',  // MusicBrainz uses tags, not genres
            style: '',
            year: releaseData.date ? parseInt(releaseData.date.substring(0, 4)) || 0 : 0,
            rpm: 0,
            tracks,
            discogsUrl: '',
            beatportUrl: '',
            coverArtUrl,
            _coverArtUrls: coverArtUrls,
            label: labelInfo?.label?.name || '',
            catalogNumber: labelInfo?.['catalog-number'] || '',
            confidence: 0.85,
            _source: 'musicbrainz'
        };
    }

    /**
     * Download cover art with redirect following, trying multiple URLs in order.
     * Returns local path like '/vinyl_covers/uuid.jpg' or null on failure.
     */
    async _downloadCoverArt(urls) {
        if (!urls || urls.length === 0) return null;

        const dataDir = path.join(process.env.DATA_DIR || '/app/data', 'vinyl_covers');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        for (const url of urls) {
            if (!url || !url.startsWith('http')) continue;
            try {
                const headers = { 'User-Agent': 'DeeDee/1.0' };
                if (url.includes('discogs.com')) {
                    const token = this._getDiscogsToken();
                    if (token) headers['Authorization'] = `Discogs token=${token}`;
                }
                const response = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    maxRedirects: 5,
                    headers,
                    validateStatus: (status) => status === 200
                });

                const contentType = response.headers['content-type'] || '';
                if (!contentType.startsWith('image/')) continue;

                const buffer = Buffer.from(response.data);
                if (buffer.length < 1000) continue;

                const ext = contentType.includes('png') ? 'png' : 'jpg';
                const filename = `${crypto.randomUUID()}.${ext}`;
                const filePath = path.join(dataDir, filename);
                fs.writeFileSync(filePath, buffer);

                console.log(`[DJService] Cover art downloaded from: ${url} (${buffer.length} bytes)`);
                return `/vinyl_covers/${filename}`;
            } catch (e) {
                console.warn(`[DJService] Cover download failed for ${url}: ${e.message}`);
                continue;
            }
        }
        return null;
    }

    /**
     * Merge two enrichment results, preferring primary for existing fields.
     * Secondary fills gaps (empty fields, missing BPM/key on tracks).
     */
    _mergeEnrichmentResults(primary, secondary) {
        const merged = { ...primary };

        const scalarFields = ['genre', 'style', 'year', 'rpm', 'label', 'catalogNumber', 'discogsUrl', 'beatportUrl'];
        for (const field of scalarFields) {
            if (!merged[field] && secondary[field]) {
                merged[field] = secondary[field];
            }
        }

        if (!merged.coverArtUrl && secondary.coverArtUrl) {
            merged.coverArtUrl = secondary.coverArtUrl;
        }

        // Merge cover art URL arrays
        const primaryUrls = merged._coverArtUrls || (merged.coverArtUrl ? [merged.coverArtUrl] : []);
        const secondaryUrls = secondary._coverArtUrls || (secondary.coverArtUrl ? [secondary.coverArtUrl] : []);
        merged._coverArtUrls = [...new Set([...primaryUrls, ...secondaryUrls])];

        // Merge track BPM/key from secondary into primary tracks
        if (merged.tracks?.length > 0 && secondary.tracks?.length > 0) {
            merged.tracks = merged.tracks.map(t => {
                const match = secondary.tracks.find(st =>
                    st.position === t.position ||
                    st.title?.toLowerCase() === t.title?.toLowerCase()
                );
                if (match) {
                    return {
                        ...t,
                        bpm: t.bpm || match.bpm || 0,
                        key: t.key || match.key || ''
                    };
                }
                return t;
            });
        } else if (!merged.tracks?.length && secondary.tracks?.length) {
            merged.tracks = secondary.tracks;
        }

        merged.confidence = Math.max(merged.confidence || 0, secondary.confidence || 0);
        return merged;
    }

    /**
     * Cascading enrichment: Discogs → MusicBrainz → Gemini grounded search.
     * Each tier fills gaps left by the previous.
     */
    async _cascadeEnrich(artist, title, label, catalogNumber) {
        let result = null;

        // Tier 1: Discogs API
        try {
            result = await this._searchDiscogs(artist, title, label, catalogNumber);
            if (result) {
                console.log(`[DJService] Cascade: Discogs matched (confidence: ${result.confidence})`);
            }
        } catch (e) {
            console.warn('[DJService] Cascade: Discogs error:', e.message);
        }

        // Tier 2: MusicBrainz + Cover Art Archive (if Discogs missed or no cover)
        if (!result || !result.coverArtUrl || !result.tracks?.length) {
            try {
                const mbResult = await this._searchMusicBrainz(artist, title, catalogNumber);
                if (mbResult) {
                    result = result ? this._mergeEnrichmentResults(result, mbResult) : mbResult;
                    console.log(`[DJService] Cascade: MusicBrainz data merged`);
                }
            } catch (e) {
                console.warn('[DJService] Cascade: MusicBrainz error:', e.message);
            }
        }

        // Tier 3: Gemini grounded search (fills BPM/key and anything else missing)
        if (!result || !result.tracks?.length || result.tracks.some(t => !t.bpm || !t.key) || !result.genre) {
            try {
                const geminiResult = await this._enrichMetadata(artist, title, label);
                if (geminiResult && Object.keys(geminiResult).length > 0) {
                    result = result ? this._mergeEnrichmentResults(result, geminiResult) : geminiResult;
                    console.log(`[DJService] Cascade: Gemini data merged`);
                }
            } catch (e) {
                console.warn('[DJService] Cascade: Gemini error:', e.message);
            }
        }

        return result || {};
    }

    /**
     * Per-track BPM/key enrichment — parallel searches to cross-reference bulk enrichment.
     * Only searches tracks missing BPM or key.
     */
    async _enrichTrackDetails(artist, tracks) {
        const tracksNeedingEnrichment = tracks.filter(t => !t.bpm || !t.key);
        if (tracksNeedingEnrichment.length === 0) {
            console.log('[DJService] All tracks already have BPM and key — skipping per-track search.');
            return tracks;
        }

        console.log(`[DJService] Per-track enrichment: ${tracksNeedingEnrichment.length}/${tracks.length} tracks need BPM/key.`);
        const modelName = this.config.getModel('FLASH');

        const searchPromises = tracksNeedingEnrichment.map(track => {
            const query = `${artist} - ${track.title}`;
            return this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [{
                        text: `Find the BPM and musical key for this track: "${query}".
Search Beatport, Discogs, decks.de, and juno.co.uk for accurate data.
Return ONLY JSON: { "bpm": number, "key": "Camelot notation (e.g. 8A, 11B)" }
Use Camelot wheel notation (1A-12B), NOT traditional key names.
If unsure, return { "bpm": 0, "key": "" }`
                    }]
                }],
                config: { tools: [{ googleSearch: {} }] }
            }).then(result => {
                let text = '';
                try {
                    if (typeof result.text === 'function') text = result.text();
                    else if (result.text) text = result.text;
                } catch (e) { /* ignore */ }
                if (!text) return { track, data: null };
                try {
                    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
                    const data = JSON.parse(cleaned);
                    console.log(`[DJService]   Per-track result: ${track.title} => BPM: ${data.bpm}, Key: ${data.key}`);
                    return { track, data };
                } catch (e) {
                    console.warn(`[DJService]   Per-track parse failed for ${track.title}: ${e.message}`);
                    return { track, data: null };
                }
            }).catch(err => {
                console.warn(`[DJService]   Per-track search failed for ${track.title}: ${err.message}`);
                return { track, data: null };
            });
        });

        const results = await Promise.allSettled(searchPromises);

        // Build lookup: track title -> per-track data
        const perTrackData = {};
        results.forEach(r => {
            if (r.status === 'fulfilled' && r.value.data) {
                perTrackData[r.value.track.title] = r.value.data;
            }
        });

        // Merge per-track data back
        return tracks.map(t => {
            const ptd = perTrackData[t.title];
            if (!ptd) return t;
            const merged = { ...t };
            if ((!merged.bpm || merged.bpm === 0) && ptd.bpm > 0) merged.bpm = ptd.bpm;
            if (!merged.key && ptd.key) {
                merged.key = this._isCamelot(ptd.key) ? ptd.key : (this._toCamelot(ptd.key) || ptd.key);
            }
            return merged;
        });
    }

    /** Check if a key string is already in Camelot notation */
    _isCamelot(key) {
        return /^(1[0-2]|[1-9])[AB]$/i.test(key?.trim());
    }

    /** Convert standard music key to Camelot notation */
    _toCamelot(key) {
        const map = {
            'Ab minor': '1A', 'Abm': '1A', 'G#m': '1A', 'G# minor': '1A',
            'B major': '1B', 'Bmaj': '1B', 'B': '1B',
            'Eb minor': '2A', 'Ebm': '2A', 'D#m': '2A', 'D# minor': '2A',
            'F# major': '2B', 'F#maj': '2B', 'Gb major': '2B', 'Gbmaj': '2B', 'F#': '2B', 'Gb': '2B',
            'Bb minor': '3A', 'Bbm': '3A', 'A#m': '3A', 'A# minor': '3A',
            'Db major': '3B', 'Dbmaj': '3B', 'C# major': '3B', 'C#maj': '3B', 'Db': '3B', 'C#': '3B',
            'F minor': '4A', 'Fm': '4A',
            'Ab major': '4B', 'Abmaj': '4B', 'G# major': '4B', 'Ab': '4B',
            'C minor': '5A', 'Cm': '5A',
            'Eb major': '5B', 'Ebmaj': '5B', 'D# major': '5B', 'Eb': '5B',
            'G minor': '6A', 'Gm': '6A',
            'Bb major': '6B', 'Bbmaj': '6B', 'A# major': '6B', 'Bb': '6B',
            'D minor': '7A', 'Dm': '7A',
            'F major': '7B', 'Fmaj': '7B', 'F': '7B',
            'A minor': '8A', 'Am': '8A',
            'C major': '8B', 'Cmaj': '8B', 'C': '8B',
            'E minor': '9A', 'Em': '9A',
            'G major': '9B', 'Gmaj': '9B', 'G': '9B',
            'B minor': '10A', 'Bm': '10A',
            'D major': '10B', 'Dmaj': '10B', 'D': '10B',
            'F# minor': '11A', 'F#m': '11A', 'Gb minor': '11A', 'Gbm': '11A',
            'A major': '11B', 'Amaj': '11B', 'A': '11B',
            'Db minor': '12A', 'Dbm': '12A', 'C# minor': '12A', 'C#m': '12A',
            'E major': '12B', 'Emaj': '12B', 'E': '12B'
        };
        return map[key?.trim()] || null;
    }

    async _prepareImagePart(imageInput) {
        // File paths
        if (typeof imageInput === 'string' && fs.existsSync(imageInput)) {
            const mimeType = imageInput.endsWith('.png') ? 'image/png' : 'image/jpeg';
            const data = fs.readFileSync(imageInput).toString('base64');
            return { inlineData: { data, mimeType } };
        }
        // Base64 object { base64, mimeType }
        if (imageInput && imageInput.base64) {
            return { inlineData: { data: imageInput.base64, mimeType: imageInput.mimeType || 'image/jpeg' } };
        }
        throw new Error('Image input format not supported');
    }

    /**
     * Recommend from Vinyl Crate
     */
    async recommendVinyl(currentTrack, chatId) {
        // 1. Get Crate
        const crate = this.db.getVinyls({ limit: 100 });
        if (crate.length === 0) return "Your crate is empty! Add some vinyls first.";

        // 2. Pro Model Reasoning
        const proModelName = process.env.WORKER_PRO || 'gemini-1.5-pro-latest';
        const model = this.agent.client.getGenerativeModel({ model: proModelName });

        const prompt = `
        You are an expert Vinyl DJ.
        Current Track: "${currentTrack}"
        
        My Crate:
        ${JSON.stringify(crate.map(v => `${v.artist} - ${v.title} (${v.label})`))}
        
        Suggest 3 tracks FROM MY CRATE ONLY that would mix well.
        Explain why (Key, BPM, Vibe).
      `;

        const result = await model.generateContent(prompt);

        // Log usage
        const usage = result.response.usageMetadata;
        if (usage) {
            this.db.logTokenUsage({
                model: proModelName,
                promptTokens: usage.promptTokenCount,
                candidateTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                chatId: chatId,
                estimatedCost: 0,
                tag: 'dj_mode' // Tag!
            });
        }

        return result.response.text();
    }

    /**
     * Recommend Digital (History + Global)
     */
    async recommendDigital(currentTrack, metadata = {}, chatId) {
        // 1. Search History Vault
        // Simple RAG: Read relevant history files?
        // For now, let's read the index or a few recent files?
        // Or searchMemory?

        // Pass the prompt to the model with contextual knowledge

        const proModelName = process.env.WORKER_PRO || 'gemini-1.5-pro-latest';
        const model = this.agent.client.getGenerativeModel({ model: proModelName });

        // Context from RAG
        let learnedContext = "";
        if (this.agent.ragService) {
            try {
                // Search for mixing advice, history, or context related to the current track or venue
                const query = `mixing advice ${currentTrack} ${metadata.venue || ''} ${metadata.party || ''}`;
                const results = await this.agent.ragService.search(query, null, 5);
                if (results.length > 0) {
                    learnedContext = "Relevant Knowledge from History:\n" + results.map(r => `- ${r.content} (Source: ${r.filename})`).join('\n');
                }
            } catch (e) {
                console.warn('[DJService] RAG Search failed:', e.message);
            }
        }

        const prompt = `
        You are an expert Digital DJ.
        Current Track: "${currentTrack}"
        Context: ${JSON.stringify(metadata)}
        
        ${learnedContext}
        
        Suggest 3 mixing paths (Smooth, Lift, Pivot).
        You can recommend ANY track in the world, but prioritize tracks that fit the context and learned knowledge.
      `;

        const result = await model.generateContent(prompt);

        // Log usage
        const usage = result.response.usageMetadata;
        if (usage) {
            this.db.logTokenUsage({
                model: proModelName,
                promptTokens: usage.promptTokenCount,
                candidateTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                chatId: chatId,
                estimatedCost: 0,
                tag: 'dj_mode'
            });
        }

        return result.response.text();
    }

    async ingestHistory(content, metadata) {
        const vaultId = 'dj_history';
        const filename = `history_${Date.now()}.md`;

        const fileContent = `---
venue: ${metadata.venue || 'Unknown'}
date: ${metadata.date || new Date().toISOString()}
party: ${metadata.party || 'Unknown'}
---

${content}
      `;

        await this.vaults.updateVaultPage(vaultId, fileContent, filename);
        return filename;
    }
}

module.exports = { DJService };
