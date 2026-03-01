const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
                    const vinyl = await this._enrichAndSave(item, imageSource);
                    ingested.push(vinyl);
                }
            }
        } else {
            const vinyl = await this._enrichAndSave(data, imageSource);
            ingested.push(vinyl);
        }

        return ingested;
    }

    async _enrichAndSave(rawItem, imageSource = null) {
        console.log(`[DJService] _enrichAndSave started for: ${rawItem.artist} - ${rawItem.title}`);

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
                console.log(`[DJService] Saved cover from file: ${coverUrl}`);
            } else if (imageSource.base64) {
                fs.writeFileSync(filePath, Buffer.from(imageSource.base64, 'base64'));
                coverUrl = `/vinyl_covers/${filename}`;
                console.log(`[DJService] Saved cover from base64: ${coverUrl}`);
            }
        }

        // 2. Broadcast enrichment status for UI
        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:enriching', {
                artist: rawItem.artist, title: rawItem.title, status: 'enriching'
            });
        }

        // 3. Metadata Enrichment via Google Search
        let enriched = {};
        try {
            console.log('[DJService] Starting metadata enrichment...');
            enriched = await this._enrichMetadata(rawItem.artist, rawItem.title, rawItem.label);
            console.log(`[DJService] Enrichment complete. Keys: ${Object.keys(enriched).join(', ')}`);
        } catch (e) {
            console.error('[DJService] Metadata enrichment failed:', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
        }

        // 3. Try to download cover art from Discogs (overrides uploaded photo)
        if (enriched.coverArtUrl && enriched.coverArtUrl.startsWith('http')) {
            try {
                const https = require('https');
                const http = require('http');
                const coverFilename = `${crypto.randomUUID()}.jpg`;
                const coverPath = path.join(dataDir, coverFilename);
                const mod = enriched.coverArtUrl.startsWith('https') ? https : http;
                await new Promise((resolve) => {
                    const req = mod.get(enriched.coverArtUrl, { headers: { 'User-Agent': 'DeeDee/1.0' } }, (res) => {
                        if (res.statusCode === 200) {
                            const fileStream = fs.createWriteStream(coverPath);
                            res.pipe(fileStream);
                            fileStream.on('finish', () => { fileStream.close(); resolve(); });
                        } else {
                            resolve();
                        }
                    });
                    req.on('error', () => resolve());
                    req.setTimeout(5000, () => { req.destroy(); resolve(); });
                });
                if (fs.existsSync(coverPath) && fs.statSync(coverPath).size > 1000) {
                    coverUrl = `/vinyl_covers/${coverFilename}`;
                    console.log(`[DJService] Downloaded cover art from: ${enriched.coverArtUrl}`);
                }
            } catch (e) {
                console.warn('[DJService] Cover art download failed:', e.message);
            }
        }

        const vinyl = {
            artist: rawItem.artist,
            title: rawItem.title,
            label: rawItem.label || enriched.label || '',
            catalogNumber: rawItem.catalog_number || enriched.catalogNumber || '',
            coverImageUrl: coverUrl,
            bpm: 0,
            key: '',
            tracks: this._normalizeTracks(rawItem.tracklist, enriched.tracks),
            meta: {
                source: 'vision',
                genre: enriched.genre || '',
                year: enriched.year || '',
                rpm: enriched.rpm || 0,
                discogsUrl: enriched.discogsUrl || '',
                beatportUrl: enriched.beatportUrl || '',
                style: enriched.style || '',
                enrichmentConfidence: enriched.confidence || 0
            }
        };

        // 4. Duplicate detection — check if vinyl with same artist+title exists
        const existing = this.db.findVinylByArtistTitle(vinyl.artist, vinyl.title);
        if (existing) {
            console.log(`[DJService] Duplicate found: "${vinyl.artist} - ${vinyl.title}" (id: ${existing.id}). Merging.`);
            // Merge: keep existing data, upgrade with better enrichment
            const mergedFields = {
                label: vinyl.label || existing.label,
                catalog_number: vinyl.catalogNumber || existing.catalog_number,
                cover_image_url: coverUrl !== '/vinyl_covers/default.png' ? coverUrl : existing.cover_image_url,
                tracks: vinyl.tracks.length > 0 ? vinyl.tracks : existing.tracks,
                meta: {
                    ...existing.meta,
                    ...vinyl.meta,
                    // Keep higher confidence
                    enrichmentConfidence: Math.max(vinyl.meta.enrichmentConfidence || 0, existing.meta?.enrichmentConfidence || 0)
                }
            };
            this.db.updateVinyl(existing.id, mergedFields);
            const updated = this.db.getVinyl(existing.id);
            if (this.agent.interface && this.agent.interface.broadcast) {
                this.agent.interface.broadcast('dj:vinyl:update', updated);
            }
            return { ...updated, _merged: true };
        }

        const id = this.db.addVinyl(vinyl);

        // Broadcast Update for UI
        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:update', { ...vinyl, id });
        }

        return { ...vinyl, id };
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
