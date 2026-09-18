/**
 * The city weather picture the morning briefing sends: today's weather for a
 * city from Open-Meteo, and the prompt that draws it.
 *
 * The briefing used to get this by running curl in the shell against the
 * api service's /v1/city-image, which calls back into the agent's /chat for a
 * whole extra turn. That broke when the shell lost its environment (the token
 * is not there any more) and its write access outside the open folders, and
 * it raised an approval card that could not work. The cityWeatherImage tool
 * does the same job in one step, inside the agent.
 */

// WMO weather codes. See https://open-meteo.com/en/docs.
const WMO_CODES = Object.freeze({
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
});

const codeToText = (code) => WMO_CODES[code] || 'Unknown conditions';

const TIMEOUT_MS = 10000;
const MAX_CITY_CHARS = 100;

async function getJson(url, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Today's weather for a city. "City, Country" picks the right one of several
 * places with the same name.
 * @returns {Promise<{ tempC: number, condition: string, highC: number, lowC: number, forecastCondition: string }>}
 */
async function fetchCityWeather(rawCity, { fetchImpl = globalThis.fetch } = {}) {
    const city = String(rawCity || '').trim().slice(0, MAX_CITY_CHARS);
    if (!city) throw new Error('A city is required.');
    const [namePart, countryHint] = city.split(',').map((s) => s.trim());

    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(namePart)}&count=5`;
    const geo = await getJson(geoUrl, fetchImpl);
    const candidates = Array.isArray(geo?.results) ? geo.results : [];
    if (candidates.length === 0) throw new Error(`No place called "${city}" was found.`);

    let match = null;
    if (countryHint) {
        const hint = countryHint.toLowerCase();
        match = candidates.find((r) => String(r.country || '').toLowerCase() === hint
            || String(r.country_code || '').toLowerCase() === hint.slice(0, 2));
    }
    match = match || candidates[0];
    if (!Number.isFinite(Number(match.latitude)) || !Number.isFinite(Number(match.longitude))) {
        throw new Error(`No coordinates for "${city}".`);
    }

    const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${Number(match.latitude)}&longitude=${Number(match.longitude)}`
        + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code'
        + '&timezone=auto&forecast_days=1';
    const fc = await getJson(forecastUrl, fetchImpl);
    const current = fc?.current;
    const daily = fc?.daily;
    if (!current || !daily) throw new Error('The weather service returned no forecast.');

    // Numbers and fixed labels only: nothing the weather service wrote as
    // free text reaches the model or the picture.
    return {
        tempC: Math.round(Number(current.temperature_2m)),
        condition: codeToText(current.weather_code),
        highC: Math.round(Number(daily.temperature_2m_max?.[0])),
        lowC: Math.round(Number(daily.temperature_2m_min?.[0])),
        forecastCondition: codeToText(daily.weather_code?.[0]),
    };
}

/** The picture's prompt: the same scene the api endpoint drew. */
function cityImagePrompt(city, weather) {
    const name = String(city || '').trim().slice(0, MAX_CITY_CHARS);
    return [
        `CITY=${name}`,
        `Present a clear, 45° top-down isometric miniature 3D cartoon scene of ${name}, featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions (${weather.condition}) directly into the city environment to create an immersive atmospheric mood.`,
        'Use a clean, minimalistic composition with a soft, solid-colored background.',
        `At the top-center, place the title "${name}" in large bold text, a prominent weather icon beneath it, then the date in text (small text) and **current** temperature (${weather.tempC}°C) (medium text) and the day weather forecast (${weather.forecastCondition}, High: ${weather.highC}°C, Low: ${weather.lowC}°C) with min and max temp (small text).`,
        'All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.',
        'IMPORTANT: The city cartoon should not reach the borders of the image.',
        'Temperature should be in Celsius.',
        'Instagram Story size, 1080x1920 dimension.',
    ].join('\n');
}

module.exports = { fetchCityWeather, cityImagePrompt, codeToText, WMO_CODES };
