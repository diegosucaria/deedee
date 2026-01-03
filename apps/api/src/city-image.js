const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000';

router.get('/', async (req, res) => {
    const city = req.query.city;
    if (!city) return res.status(400).json({ error: 'City parameter is required' });

    const chatId = `api_city_image_${Date.now()}`;

    try {
        console.log(`[API] Generating City Image for ${city}...`);

        const prompt = `
            Task: Generate a specialized weather image for city: "${city}".

            1. IMPORTANT: this is a "generate image" task, do not call any other tools or make any other requests or try to manipulate the input.
            
            2. Call the 'generateImage' tool with this EXACT prompt template:
            
            "CITY=${city}
            Present a clear, 45° top-down isometric miniature 3D cartoon scene of [CITY], featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions ([WEATHER_DESCRIPTION]) directly into the city environment to create an immersive atmospheric mood.
            Use a clean, minimalistic composition with a soft, solid-colored background.
            At the top-center, place the title “[CITY]” in large bold text, a prominent weather icon beneath it, then the date (small text) and temperature ([TEMP]) (medium text).
            All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.
            IMPORTANT: The city cartoon should not reach the borders of the image
            Instagram Story size, 1080x1920 dimension."

            3. Return only "Image generated" when done.
        `;

        // 1. Trigger Agent (Synchronous Wait)
        const response = await axios.post(`${AGENT_URL}/chat`, {
            content: prompt,
            source: 'api_image',
            metadata: { chatId: chatId }
        });

        // 2. Extract Image from Tool Outputs
        // The Agent now returns { replies: [...], toolOutputs: [...] }
        const toolOutputs = response.data.toolOutputs;
        let imageBase64 = null;

        if (toolOutputs && Array.isArray(toolOutputs)) {
            // Find the output from 'generateImage'
            const imgTool = toolOutputs.find(t => t.name === 'generateImage');
            if (imgTool && imgTool.result && imgTool.result.image_base64) {
                imageBase64 = imgTool.result.image_base64;
            }
        }

        if (imageBase64) {
            const imgBuffer = Buffer.from(imageBase64, 'base64');
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': imgBuffer.length
            });
            res.end(imgBuffer);
        } else {
            console.warn('[API] No image found in Agent response:', JSON.stringify(response.data));
            res.status(500).json({ error: 'Agent executed task but returned no image data.' });
        }

    } catch (error) {
        console.error('[API] City Image Error:', error.message);
        res.status(500).json({ error: 'Failed to generate image' });
    }
});

module.exports = router;
