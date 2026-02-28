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
        // 1. Save uploaded photo as initial cover
        let coverUrl = '/vinyl_covers/default.png';
        const dataDir = path.join(process.cwd(), 'data/vinyl_covers');
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

        // 2. Metadata Enrichment via Google Search
        let enriched = {};
        try {
            enriched = await this._enrichMetadata(rawItem.artist, rawItem.title, rawItem.label);
        } catch (e) {
            console.warn('[DJService] Metadata enrichment failed:', e.message);
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
                discogsUrl: enriched.discogsUrl || '',
                beatportUrl: enriched.beatportUrl || '',
                style: enriched.style || '',
                enrichmentConfidence: enriched.confidence || 0
            }
        };

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
        console.log(`[DJService] Enriching metadata for: ${query}`);

        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [{
                        text: `Look up this vinyl record: "${query}". Find on Discogs or Beatport.
Return JSON with:
{
  "genre": "string",
  "style": "string (subgenre)",
  "year": number,
  "tracks": [
    { "position": "A1", "title": "Track Name", "bpm": number, "key": "string (e.g. Am, Cm, F#m)" }
  ],
  "discogsUrl": "URL or empty",
  "beatportUrl": "URL or empty",
  "coverArtUrl": "Direct image URL of the vinyl cover from Discogs or empty",
  "label": "string",
  "catalogNumber": "string",
  "confidence": number between 0 and 1 indicating how confident you are that this is the correct record
}
IMPORTANT: BPM and key are PER TRACK, not per vinyl. Each track in the tracklist should have its own BPM and key.
If you cannot find exact data, provide your best estimate and set confidence accordingly. Respond ONLY with valid JSON.` }]
                }],
                config: {
                    responseMimeType: 'application/json',
                    tools: [{ googleSearch: {} }]
                }
            });

            let text = '';
            try {
                if (typeof result.text === 'function') text = result.text();
                else if (result.text) text = result.text;
                else if (result.candidates?.[0]?.content?.parts) {
                    text = result.candidates[0].content.parts.map(p => p.text).filter(Boolean).join('');
                }
            } catch (e) { /* ignore */ }

            if (text) {
                const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
                const data = JSON.parse(cleaned);
                console.log(`[DJService] Enriched: Genre=${data.genre}, Year=${data.year}, Tracks=${data.tracks?.length || 0}, Confidence=${data.confidence}`);
                return data;
            }
        } catch (e) {
            console.warn('[DJService] Search enrichment failed:', e.message);
        }

        return {};
    }

    /**
     * Normalize tracks: merge vision-extracted strings with enriched objects.
     * Output: [{ position, title, bpm, key }]
     */
    _normalizeTracks(visionTracks, enrichedTracks) {
        // Prefer enriched (structured objects with bpm/key)
        if (enrichedTracks && Array.isArray(enrichedTracks) && enrichedTracks.length > 0) {
            // If enriched tracks are already objects, use them
            if (typeof enrichedTracks[0] === 'object') return enrichedTracks;
            // If they're strings, convert
            return enrichedTracks.map((t, i) => {
                if (typeof t === 'string') {
                    return { position: `${i + 1}`, title: t, bpm: 0, key: '' };
                }
                return t;
            });
        }
        // Fall back to vision strings
        if (visionTracks && Array.isArray(visionTracks) && visionTracks.length > 0) {
            return visionTracks.map((t, i) => {
                if (typeof t === 'string') {
                    return { position: `${i + 1}`, title: t, bpm: 0, key: '' };
                }
                return t;
            });
        }
        return [];
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
