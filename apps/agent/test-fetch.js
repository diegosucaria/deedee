require('dotenv').config({ path: '../../.env' });
const fs = require('fs');
const { getConsolidationPrompt } = require('./src/prompts/memory.js');

const fullText = fs.readFileSync('../../test-logs-dump.js', 'utf8');
const logs = fullText.split('--- WHAT THE LLM SEES ---')[1] || fullText;

async function run() {
    console.log("Starting fetch test...");
    const prompt = getConsolidationPrompt('2026-02-22', logs);

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json' }
            })
        });

        const data = await response.json();
        console.log("=== OUTPUT ===");
        if (data.candidates && data.candidates.length > 0) {
            console.log(data.candidates[0].content.parts[0].text);
        } else {
            console.log("No candidates returned. Response:", data);
        }
    } catch (e) {
        console.error("Failed:", e);
    }
}
run();
