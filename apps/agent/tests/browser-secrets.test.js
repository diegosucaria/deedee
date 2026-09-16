const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { renderDotenv, writeSecrets, readSecretNames, regenerateEnv, secretsPaths } = require('../src/utils/browser-secrets');

describe('renderDotenv', () => {
    test('single-quotes plain values so dotenv returns them unchanged', () => {
        const out = renderDotenv({ SITE_USER: 'someone', SITE_PASS: 'a"b\\c#d e' });
        expect(out).toBe("SITE_USER='someone'\nSITE_PASS='a\"b\\c#d e'\n");
        expect(dotenv.parse(out)).toEqual({ SITE_USER: 'someone', SITE_PASS: 'a"b\\c#d e' });
    });

    test('double-quotes values that hold a single quote and escapes newlines', () => {
        const out = renderDotenv({ K: "it's", L: 'l1\nl2' });
        expect(out).toBe('K="it\'s"\nL="l1\\nl2"\n');
        expect(dotenv.parse(out)).toEqual({ K: "it's", L: 'l1\nl2' });
    });

    test('round-trips awkward values through dotenv.parse', () => {
        const values = ['plain', 'a"b', 'a\\b', "a'b", 'x#y', ' lead', 'trail ', 'back\\\\slash', 'nl\\nliteral', 'p@ss=w0rd', '$HOME', '${X}', 'mix"#\\z'];
        const secrets = Object.fromEntries(values.map((v, i) => [`K${i}`, v]));
        expect(dotenv.parse(renderDotenv(secrets))).toEqual(secrets);
    });

    test('renders an empty object as an empty file', () => {
        expect(renderDotenv({})).toBe('');
    });

    test('rejects bad names, non-string values, non-objects and unquotable values', () => {
        expect(() => renderDotenv({ 'bad-name': 'x' })).toThrow('Invalid secret name');
        expect(() => renderDotenv({ lower: 'x' })).toThrow('Invalid secret name');
        expect(() => renderDotenv({ OK: 5 })).toThrow('must be a string');
        expect(() => renderDotenv(['A'])).toThrow('JSON object');
        expect(() => renderDotenv(null)).toThrow('JSON object');
        expect(() => renderDotenv({ BOTH: `a'b"c` })).toThrow('single and a double quote');
    });
});

describe('writeSecrets / readSecretNames / regenerateEnv', () => {
    let dataDir;
    beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-secrets-')); });

    test('writes both files and lists names only', () => {
        expect(writeSecrets(dataDir, { B_KEY: 'v2', A_KEY: 'v1' })).toBe(2);
        const { json, env } = secretsPaths(dataDir);
        expect(JSON.parse(fs.readFileSync(json, 'utf8'))).toEqual({ B_KEY: 'v2', A_KEY: 'v1' });
        expect(fs.readFileSync(env, 'utf8')).toBe("B_KEY='v2'\nA_KEY='v1'\n");
        expect(readSecretNames(dataDir)).toEqual(['A_KEY', 'B_KEY']);
    });

    test('a bad key writes nothing', () => {
        expect(() => writeSecrets(dataDir, { GOOD: 'x', 'bad key': 'y' })).toThrow();
        expect(fs.existsSync(secretsPaths(dataDir).json)).toBe(false);
    });

    test('regenerateEnv rebuilds the dotenv from the JSON and skips bad entries', () => {
        const { dir, json, env } = secretsPaths(dataDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(json, JSON.stringify({ OK: 'v', 'bad-name': 'x', NUM: 3, BOTH: `a'b"c` }));
        expect(regenerateEnv(dataDir)).toBe(1);
        expect(fs.readFileSync(env, 'utf8')).toBe("OK='v'\n");
    });

    test('regenerateEnv with no JSON writes an empty dotenv', () => {
        expect(regenerateEnv(dataDir)).toBe(0);
        expect(fs.readFileSync(secretsPaths(dataDir).env, 'utf8')).toBe('');
        expect(readSecretNames(dataDir)).toEqual([]);
    });
});
