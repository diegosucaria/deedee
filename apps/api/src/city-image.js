const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000';

// WMO weather codes → human-readable text. See https://open-meteo.com/en/docs.
const WMO_CODES = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
};

const codeToText = (code) => WMO_CODES[code] || 'Unknown conditions';

async function fetchWeather(rawCity) {
    // Honor a "City,Country" hint so "Cordoba,Argentina" doesn't match Cordoba, Spain.
    const [namePart, countryHint] = rawCity.split(',').map((s) => s.trim());

    const geo = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: { name: namePart, count: 5 },
        timeout: 10000,
    });
    const candidates = geo.data?.results || [];
    if (candidates.length === 0) throw new Error(`Geocoding failed for "${rawCity}"`);

    let match;
    if (countryHint) {
        const hint = countryHint.toLowerCase();
        match = candidates.find(
            (r) =>
                r.country?.toLowerCase() === hint ||
                r.country_code?.toLowerCase() === hint.slice(0, 2),
        );
    }
    match = match || candidates[0];

    const fc = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
            latitude: match.latitude,
            longitude: match.longitude,
            current: 'temperature_2m,weather_code',
            daily: 'temperature_2m_max,temperature_2m_min,weather_code',
            timezone: 'auto',
            forecast_days: 1,
        },
        timeout: 10000,
    });

    const current = fc.data?.current;
    const daily = fc.data?.daily;
    if (!current || !daily) throw new Error('Open-Meteo returned no data');

    return {
        tempC: Math.round(current.temperature_2m),
        condition: codeToText(current.weather_code),
        highC: Math.round(daily.temperature_2m_max?.[0]),
        lowC: Math.round(daily.temperature_2m_min?.[0]),
        forecastCondition: codeToText(daily.weather_code?.[0]),
    };
}

router.get('/', async (req, res) => {
    const city = req.query.city;
    if (!city) return res.status(400).json({ error: 'City parameter is required' });

    const chatId = `api_city_image_${Date.now()}`;

    try {
        console.log(`[API] Generating City Image for ${city}...`);

        let weather;
        try {
            weather = await fetchWeather(city);
            console.log(`[API] Weather for ${city}:`, weather);
        } catch (err) {
            // Don't render an image with hallucinated weather — let the briefing's
            // BYTES-threshold check treat this as a failed image and fall back to text.
            console.error(`[API] Weather fetch failed for ${city}: ${err.message}`);
            return res.status(503).json({ error: `Weather lookup failed: ${err.message}` });
        }

        const tempStr = `${weather.tempC}°C`;
        const forecastStr = `${weather.forecastCondition}, High: ${weather.highC}°C, Low: ${weather.lowC}°C`;

        const prompt = `
            "CITY=${city}
            Present a clear, 45° top-down isometric miniature 3D cartoon scene of ${city}, featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions (${weather.condition}) directly into the city environment to create an immersive atmospheric mood.
            Use a clean, minimalistic composition with a soft, solid-colored background.
            At the top-center, place the title “${city}” in large bold text, a prominent weather icon beneath it, then the date in text (small text) and **current** temperature (${tempStr}) (medium text) and the day weather forecast (${forecastStr}) with min and max temp (small text).
            All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.
            IMPORTANT: The city cartoon should not reach the borders of the image.
            Temperature should be in Celsius.
            Instagram Story size, 1080x1920 dimension."
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
