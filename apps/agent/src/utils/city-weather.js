/**
 * The city weather picture the morning briefing sends: today's weather for a
 * city from Open-Meteo, and the prompt that draws it.
 *
 * The briefing used to get this through the shell: curl to the api service's
 * /v1/city-image, which then called the agent's /chat for an extra turn. The
 * shell lost the token and its write access outside the open folders, so
 * that broke. The cityWeatherImage tool now does the job in one step.
 */

// WMO weather codes. See https://open-meteo.com/en/docs.
const WMO_CODES = {
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
};

const codeToText = (code) => (Object.prototype.hasOwnProperty.call(WMO_CODES, code) ? WMO_CODES[code] : 'Unknown conditions');

const TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 1500;
const MAX_CITY_CHARS = 100;
const CANDIDATES = 10;

/**
 * A failure the tool can show the model. Its text is always ours: nothing the
 * weather service sent, and never Node's "fetch failed", which the scheduler
 * reads as a broken run and uses to drop the whole reply.
 */
class WeatherError extends Error { }

async function getJson(url, fetchImpl, { retryDelayMs = RETRY_DELAY_MS } = {}) {
    let res;
    // One more try on a network error or a server error: the briefing runs
    // once a day, and a single dropped connection should not cost the picture.
    for (let attempt = 1; ; attempt++) {
        try {
            res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
            res = null;
        }
        if (res && (res.ok || res.status < 500)) break;
        if (attempt >= 2) break;
        await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    if (!res) throw new WeatherError('the weather service could not be reached');
    if (!res.ok) throw new WeatherError(`the weather service answered ${res.status}`);
    try {
        return await res.json();
    } catch {
        // A parse error quotes the body. The body is not ours to show.
        throw new WeatherError('the weather service sent something that is not a forecast');
    }
}

/** Lower case with the accents gone, so "México" meets "Mexico". */
function fold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * The place a "City", "City, Country" or "City, Region, Country" string
 * names, among the service's results. The country is the last part. A hint
 * that names nothing in the results is an error, never a quiet swap for
 * another place with the same name.
 */
function pickPlace(candidates, { country = '', region = '' } = {}) {
    const wantCountry = fold(country);
    const wantRegion = fold(region);
    const countryHit = (r) => {
        if (!wantCountry) return true;
        // A two-letter hint is a country code; anything else is a name.
        if (wantCountry.length === 2) return fold(r.country_code) === wantCountry;
        return fold(r.country) === wantCountry;
    };
    const regionHit = (r) => !wantRegion || fold(r.admin1) === wantRegion || fold(r.admin2) === wantRegion;
    return candidates.find((r) => countryHit(r) && regionHit(r))
        // A region that matches nothing is not worth failing over when the
        // country does match: "Córdoba, Córdoba, Argentina" is still Argentina.
        || (wantRegion ? candidates.find(countryHit) : null)
        || null;
}

async function searchPlaces(name, language, fetchImpl, retryDelayMs) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${CANDIDATES}&language=${language}`;
    const geo = await getJson(url, fetchImpl, { retryDelayMs });
    return Array.isArray(geo?.results) ? geo.results : [];
}

/**
 * A place name as the model may read it. The result is not wrapped as
 * untrusted, so a name keeps only the characters a name needs, and a short
 * length: letters, accents, spaces and a little punctuation.
 */
function placeName(value) {
    const clean = String(value || '').replace(/[^\p{L}\p{M}\s'.,()-]/gu, '').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 60) : null;
}

/**
 * Today's weather for a city, and the place it found.
 * @returns {Promise<{ tempC: number, condition: string, highC: number, lowC: number, forecastCondition: string,
 *   date: string, place: { name: string, region: string|null, country: string|null } }>}
 */
async function fetchCityWeather(rawCity, { fetchImpl = globalThis.fetch, retryDelayMs = RETRY_DELAY_MS } = {}) {
    const city = String(rawCity || '').trim().slice(0, MAX_CITY_CHARS);
    if (!city) throw new WeatherError('a city is required');
    const parts = city.split(',').map((s) => s.trim()).filter(Boolean);
    const name = parts[0];
    const country = parts.length > 1 ? parts[parts.length - 1] : '';
    const region = parts.length > 2 ? parts.slice(1, -1).join(', ') : '';

    let candidates = await searchPlaces(name, 'en', fetchImpl, retryDelayMs);
    if (candidates.length === 0) throw new WeatherError(`no place called "${name}" was found`);
    let match = country ? pickPlace(candidates, { country, region }) : candidates[0];
    if (!match && country) {
        // He writes in Spanish as often as in English: "Estados Unidos",
        // "Reino Unido". Ask for the Spanish names and match those.
        candidates = await searchPlaces(name, 'es', fetchImpl, retryDelayMs);
        match = pickPlace(candidates, { country, region });
    }
    if (!match) throw new WeatherError(`no place called "${name}" was found in ${country}`);

    const lat = Number(match.latitude);
    const lon = Number(match.longitude);
    if (match.latitude == null || match.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new WeatherError(`no coordinates for "${name}"`);
    }

    const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat}&longitude=${lon}`
        + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code'
        + '&timezone=auto&forecast_days=1';
    const fc = await getJson(forecastUrl, fetchImpl, { retryDelayMs });
    const current = fc?.current || {};
    const daily = fc?.daily || {};

    // Every figure must be a real number. A missing one used to become "0°C"
    // or "NaN°C" on the picture, which is weather nobody measured.
    const figure = (value) => (value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)));
    const tempC = figure(current.temperature_2m);
    const highC = figure(daily.temperature_2m_max?.[0]);
    const lowC = figure(daily.temperature_2m_min?.[0]);
    const date = typeof daily.time?.[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daily.time[0]) ? daily.time[0] : null;
    if (tempC === null || highC === null || lowC === null || !date) {
        throw new WeatherError('the weather service returned an incomplete forecast');
    }

    // Numbers, fixed labels and the place's name only: nothing else the
    // weather service wrote reaches the model or the picture.
    return {
        tempC,
        condition: codeToText(current.weather_code),
        highC,
        lowC,
        forecastCondition: codeToText(daily.weather_code?.[0]),
        date,
        place: {
            name: placeName(match.name) || placeName(name) || 'the city',
            region: placeName(match.admin1),
            country: placeName(match.country),
        },
    };
}

/** "2026-09-18" as "Friday, 18 September 2026", the day in the city itself. */
function longDate(isoDay) {
    const d = new Date(`${isoDay}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The picture's prompt: the scene the api endpoint drew, with the date it lacked. */
function cityImagePrompt(title, weather) {
    const name = String(title || '').trim().slice(0, MAX_CITY_CHARS);
    return [
        `CITY=${name}`,
        `Present a clear, 45° top-down isometric miniature 3D cartoon scene of ${name}, featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions (${weather.condition}) directly into the city environment to create an immersive atmospheric mood.`,
        'Use a clean, minimalistic composition with a soft, solid-colored background.',
        `At the top-center, place the title "${name}" in large bold text, a prominent weather icon beneath it, then the date "${longDate(weather.date)}" in text (small text) and **current** temperature (${weather.tempC}°C) (medium text) and the day weather forecast (${weather.forecastCondition}, High: ${weather.highC}°C, Low: ${weather.lowC}°C) with min and max temp (small text).`,
        'All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.',
        'IMPORTANT: The city cartoon should not reach the borders of the image.',
        'Temperature should be in Celsius.',
    ].join('\n');
}

module.exports = { fetchCityWeather, cityImagePrompt, WeatherError };
