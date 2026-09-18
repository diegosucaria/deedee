/**
 * cityWeatherImage: the morning briefing's picture in one step. It used to be
 * a shell curl to the api service with a token the shell no longer has,
 * written to a folder the shell no longer opens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchCityWeather, cityImagePrompt } = require('../src/utils/city-weather');
const { MediaExecutor } = require('../src/executors/media');
const { taintedAction, classifyToolResult } = require('../src/utils/untrusted-content');

const GEO = { results: [
    { name: 'Springfield', country: 'United States', country_code: 'US', latitude: 39.8, longitude: -89.6 },
    { name: 'Springfield', country: 'Australia', country_code: 'AU', latitude: -27.6, longitude: 152.9 },
] };
const FORECAST = {
    current: { temperature_2m: 21.4, weather_code: 2 },
    daily: { temperature_2m_max: [27.6], temperature_2m_min: [14.2], weather_code: [61] },
};

function fakeFetch({ geo = GEO, forecast = FORECAST, fail = null } = {}) {
    const calls = [];
    const impl = async (url) => {
        calls.push(url);
        if (fail && url.includes(fail)) return { ok: false, status: 503, json: async () => ({}) };
        const body = url.includes('geocoding') ? geo : forecast;
        return { ok: true, status: 200, json: async () => body };
    };
    return { impl, calls };
}

describe('fetchCityWeather', () => {
    test('numbers and fixed labels only, rounded', async () => {
        const { impl } = fakeFetch();
        await expect(fetchCityWeather('Springfield', { fetchImpl: impl })).resolves.toEqual({
            tempC: 21, condition: 'Partly cloudy', highC: 28, lowC: 14, forecastCondition: 'Slight rain',
        });
    });

    test('a country hint picks the right one of two places with the same name', async () => {
        const { impl, calls } = fakeFetch();
        await fetchCityWeather('Springfield, Australia', { fetchImpl: impl });
        expect(calls[1]).toContain('latitude=-27.6');
        // The name is sent encoded, and the hint is not part of it.
        expect(calls[0]).toContain('name=Springfield&');
    });

    test('an unknown place, a failed service or an empty city throws instead of guessing', async () => {
        await expect(fetchCityWeather('Nowhere', { fetchImpl: fakeFetch({ geo: { results: [] } }).impl })).rejects.toThrow(/No place/);
        await expect(fetchCityWeather('Springfield', { fetchImpl: fakeFetch({ fail: 'forecast' }).impl })).rejects.toThrow(/HTTP 503/);
        await expect(fetchCityWeather('  ', { fetchImpl: fakeFetch().impl })).rejects.toThrow(/required/);
    });

    test('the prompt carries the weather and the city', () => {
        const text = cityImagePrompt('Springfield', { tempC: 21, condition: 'Partly cloudy', highC: 28, lowC: 14, forecastCondition: 'Slight rain' });
        expect(text).toContain('CITY=Springfield');
        expect(text).toContain('(21°C)');
        expect(text).toContain('High: 28°C, Low: 14°C');
    });
});

describe('the cityWeatherImage tool', () => {
    let dir, spies;
    const OLD_FETCH = globalThis.fetch;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-cityimg-'));
        process.env.DATA_DIR = dir;
        globalThis.fetch = fakeFetch().impl;
        spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        globalThis.fetch = OLD_FETCH;
        spies.forEach(s => s.mockRestore());
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const services = (generateContent) => ({
        client: { models: { generateContent } },
        agent: { configService: { getModel: () => 'image-model' } },
        db: { logTokenUsage: jest.fn() },
    });

    test('saves the picture under output/ and sends nothing', async () => {
        const png = Buffer.from('fake-png-bytes').toString('base64');
        const generateContent = jest.fn().mockResolvedValue({
            candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: png } }] } }],
        });
        const sendCallback = jest.fn();
        const svc = services(generateContent);
        const out = await new MediaExecutor(svc).execute('cityWeatherImage', { city: 'Springfield' }, { message: { metadata: { chatId: 'scheduled_x_1' } }, sendCallback }, svc);

        expect(out).toMatchObject({ success: true, city: 'Springfield', bytes: Buffer.from(png, 'base64').length });
        expect(out.imagePath).toBe(path.join(dir, 'output', 'briefing', 'city.png'));
        expect(fs.readFileSync(out.imagePath).toString()).toBe('fake-png-bytes');
        expect(out.weather).toMatchObject({ tempC: 21, highC: 28, lowC: 14 });
        // The job sends it with the briefing as its caption.
        expect(sendCallback).not.toHaveBeenCalled();
        // The image model's own text never comes back to the model.
        expect(JSON.stringify(out)).not.toContain('here you go');
    });

    test('no weather means no picture, so the job falls back to text', async () => {
        globalThis.fetch = fakeFetch({ fail: 'forecast' }).impl;
        const generateContent = jest.fn();
        const svc = services(generateContent);
        const out = await new MediaExecutor(svc).execute('cityWeatherImage', { city: 'Springfield' }, { message: { metadata: {} } }, svc);
        expect(out).toMatchObject({ success: false });
        expect(out.error).toMatch(/Weather lookup failed/);
        expect(generateContent).not.toHaveBeenCalled();
    });

    test('a job run that read a sub-agent report can still call it', () => {
        // The briefing's run is tainted by its sub-agents' reports. This tool
        // reaches no one and changes nothing outside output/, so it must not
        // pause, and its result is ours: numbers, a path and fixed labels.
        expect(taintedAction('cityWeatherImage', { city: 'Springfield' })).toBeNull();
        expect(classifyToolResult('cityWeatherImage', { args: {}, result: { success: true } }).untrusted).toBeFalsy();
    });
});
