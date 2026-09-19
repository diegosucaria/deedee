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
const CANDIDATES = 50;

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
    } catch (e) {
        // The body stalled: the same as not reaching the service.
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new WeatherError('the weather service could not be reached');
        // A parse error quotes the body. The body is not ours to show.
        throw new WeatherError('the weather service sent something that is not a forecast');
    }
}

/** Lower case with the accents gone, so "México" meets "Mexico". */
function fold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Ways people write a country that no list of official names holds.
const COUNTRY_ALIASES = {
    usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'united states of america': 'US', america: 'US', eeuu: 'US', 'ee.uu.': 'US',
    uk: 'GB', 'u.k.': 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
    inglaterra: 'GB', escocia: 'GB', holland: 'NL', holanda: 'NL', turkey: 'TR', turquia: 'TR',
    'czech republic': 'CZ', 'republica checa': 'CZ', uae: 'AE',
};

// US state codes: "Paris, TX" means Texas. A two-letter hint is read as a
// country code first, so "Richmond, CA" stays Canada; write "California".
const US_STATES = {
    al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado', ct: 'Connecticut',
    de: 'Delaware', fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
    ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan',
    mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire',
    nj: 'New Jersey', nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio',
    ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
    tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington', wv: 'West Virginia',
    wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia',
};

let countryNames = null;
/** Country names in English and Spanish, folded, to their two-letter codes. Built once. */
function countryCodeByName() {
    if (countryNames) return countryNames;
    countryNames = new Map();
    try {
        const lists = ['en', 'es'].map((lang) => new Intl.DisplayNames([lang], { type: 'region' }));
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (const a of A) {
            for (const b of A) {
                const code = a + b;
                for (const names of lists) {
                    const name = names.of(code);
                    if (name && name !== code) countryNames.set(fold(name), code);
                }
            }
        }
    } catch { /* no Intl data: the plain name comparison below still works */ }
    return countryNames;
}

/** The two-letter code a country hint names, or null. */
function countryCodeOf(hint) {
    const want = fold(hint);
    if (!want) return null;
    if (COUNTRY_ALIASES[want]) return COUNTRY_ALIASES[want];
    const byName = countryCodeByName().get(want);
    if (byName) return byName;
    return /^[a-z]{2}$/.test(want) ? want.toUpperCase() : null;
}

// How far down the service's list a place with another name may be taken.
// The service also matches old and alternate names ("Springfield" finds a
// town now called Jackson), so beyond the top few only an exact name counts.
const LOOSE = 10;

/**
 * The place a "City", "City, Country", "City, Region, Country" or
 * "City, State" string names, among the service's results. The country is the
 * last part. A hint that names nothing in the results is an error, never a
 * quiet swap for another place with the same name.
 */
function pickPlace(candidates, { name = '', country = '', region = '' } = {}) {
    const wantName = fold(name);
    const wantRegion = fold(region);
    const hint = fold(country);
    const code = countryCodeOf(country);
    const sameName = (r) => fold(r.name) === wantName;
    // An exact name anywhere in the list first, then any name near the top.
    const find = (test) => candidates.find((r) => sameName(r) && test(r))
        || candidates.slice(0, LOOSE).find(test)
        || null;
    const inCountry = (r) => (code && String(r.country_code || '').toUpperCase() === code) || fold(r.country) === hint;
    const inRegion = (r, want) => {
        const a = fold(r.admin1);
        return !!a && (a === want || a.includes(want) || want.includes(a));
    };

    if (wantRegion) {
        return find((r) => inCountry(r) && inRegion(r, wantRegion))
            // People repeat the city as its own province ("Córdoba, Córdoba,
            // Argentina"). Only then is the country alone enough; any other
            // region that matches nothing is an error, not the first city.
            || (wantRegion === wantName ? find(inCountry) : null);
    }
    // "Lima, Lima": the hint repeats the name and adds nothing.
    if (hint === wantName) return candidates[0] || null;
    return find(inCountry)
        // "Paris, TX": a US state code, when no country has that code here.
        || (US_STATES[hint] ? find((r) => String(r.country_code || '').toUpperCase() === 'US' && fold(r.admin1) === fold(US_STATES[hint])) : null)
        // "Paris, Texas": the last part may be a state or a province. The
        // first-level region only: a county or a district of that name
        // elsewhere ("Buenos Aires" in Brazil) is not what he means.
        || find((r) => fold(r.admin1) === hint);
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
    const clean = String(value || '').replace(/[^\p{L}\p{M}\s'.,()-]/gu, ' ').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 60) : null;
}

/**
 * Today's weather for a city, and the place it found.
 * @returns {Promise<{ tempC: number, condition: string, highC: number, lowC: number, forecastCondition: string,
 *   date: string, place: { name: string, region: string|null, country: string|null } }>}
 */
async function fetchCityWeather(rawCity, { fetchImpl = globalThis.fetch, retryDelayMs = RETRY_DELAY_MS } = {}) {
    const city = String(rawCity || '').trim().slice(0, MAX_CITY_CHARS);
    const parts = city.split(',').map((s) => s.trim()).filter(Boolean);
    const name = parts[0];
    if (!name) throw new WeatherError('a city is required');
    const country = parts.length > 1 ? parts[parts.length - 1] : '';
    const region = parts.length > 2 ? parts.slice(1, -1).join(', ') : '';

    // He writes a city in Spanish as often as in English ("Londres",
    // "Estocolmo"), and the English search then finds a village of that name
    // or nothing at all. So both lists are asked.
    const english = await searchPlaces(name, 'en', fetchImpl, retryDelayMs);
    let match = null;
    if (country) {
        match = pickPlace(english, { name, country, region });
        if (!match) match = pickPlace(await searchPlaces(name, 'es', fetchImpl, retryDelayMs), { name, country, region });
        if (!match) throw new WeatherError(`no place called "${name}" was found in ${country}`);
    } else {
        const spanish = await searchPlaces(name, 'es', fetchImpl, retryDelayMs);
        // A bare name means the well-known one: the larger of the two first results.
        const firsts = [english[0], spanish[0]].filter(Boolean);
        match = firsts.sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0))[0] || null;
        if (!match) throw new WeatherError(`no place called "${name}" was found`);
    }

    const lat = match.latitude;
    const lon = match.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
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
    const figure = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
    const tempC = figure(current.temperature_2m);
    const highC = figure(daily.temperature_2m_max?.[0]);
    const lowC = figure(daily.temperature_2m_min?.[0]);
    const day = daily.time?.[0];
    const date = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(new Date(`${day}T12:00:00Z`).getTime()) ? day : null;
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
    // Which Córdoba? The scene needs the whole place; the title stays short.
    const where = [name, weather.place?.region, weather.place?.country].filter((p, i, all) => p && all.indexOf(p) === i).join(', ');
    return [
        `CITY=${where}`,
        `Present a clear, 45° top-down isometric miniature 3D cartoon scene of ${where}, featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions (${weather.condition}) directly into the city environment to create an immersive atmospheric mood.`,
        'Use a clean, minimalistic composition with a soft, solid-colored background.',
        `At the top-center, place the title "${name}" in large bold text, a prominent weather icon beneath it, then the date "${longDate(weather.date)}" in text (small text) and **current** temperature (${weather.tempC}°C) (medium text) and the day weather forecast (${weather.forecastCondition}, High: ${weather.highC}°C, Low: ${weather.lowC}°C) with min and max temp (small text).`,
        'All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.',
        'IMPORTANT: The city cartoon should not reach the borders of the image.',
        'Temperature should be in Celsius.',
    ].join('\n');
}

module.exports = { fetchCityWeather, cityImagePrompt, WeatherError };
