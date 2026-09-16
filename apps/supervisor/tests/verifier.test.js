const child_process = require('child_process');

jest.mock('child_process', () => ({
    exec: jest.fn((cmd, opts, cb) => {
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    }),
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    })
}));

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true) // node_modules present: no npm install
}));

const { Verifier, isSafePath } = require('../src/verifier');

describe('Verifier', () => {
    let verifier;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        verifier = new Verifier('/tmp/work');
    });

    afterEach(() => jest.restoreAllMocks());

    test('runs node --check through execFile with the file as one argument', async () => {
        await verifier.verify(['apps/agent/src/a.js', 'packages/core/b.mjs', 'docs/notes.md']);

        const checks = child_process.execFile.mock.calls.filter(call => call[0] === 'node');
        expect(checks.map(call => call[1])).toEqual([
            ['--check', 'apps/agent/src/a.js'],
            ['--check', 'packages/core/b.mjs']
        ]);
        expect(checks.every(call => call[2].cwd === '/tmp/work')).toBe(true);
        // No shell command ever carries a file name
        expect(child_process.exec.mock.calls.every(([cmd]) => !cmd.includes('.js'))).toBe(true);
    });

    test('rejects a name with ; before running anything', async () => {
        await expect(verifier.verify(['apps/agent/src/a.js; touch /tmp/pwned.js']))
            .rejects.toThrow(/Unsafe file name/);
        expect(child_process.execFile).not.toHaveBeenCalled();
        expect(child_process.exec).not.toHaveBeenCalled();
    });

    test('rejects a name with $( before running anything', async () => {
        await expect(verifier.verify(['apps/agent/src/$(id).js']))
            .rejects.toThrow(/Unsafe file name/);
        expect(child_process.execFile).not.toHaveBeenCalled();
        expect(child_process.exec).not.toHaveBeenCalled();
    });

    test('reports a syntax error with the file name', async () => {
        child_process.execFile.mockImplementationOnce((file, args, opts, cb) => {
            cb(Object.assign(new Error('exit 1'), { stderr: 'SyntaxError: Unexpected token' }));
            return { unref: () => { } };
        });

        await expect(verifier.verify(['apps/agent/src/bad.js']))
            .rejects.toThrow(/Syntax Error in apps\/agent\/src\/bad.js: SyntaxError/);
    });

    test('isSafePath', () => {
        expect(isSafePath('apps/web/src/app/chat/[id]/page.js')).toBe(true);
        expect(isSafePath('patches/@scope+pkg+1.0.0.patch')).toBe(true);
        expect(isSafePath('apps/agent/Dockerfile')).toBe(true);
        expect(isSafePath('apps/agent/src/my file.js')).toBe(false);
        expect(isSafePath('apps/agent/src/a;b.js')).toBe(false);
        expect(isSafePath('apps/agent/src/$(id).js')).toBe(false);
        expect(isSafePath('apps/agent/src/`id`.js')).toBe(false);
        expect(isSafePath('apps/agent/src/a|b.js')).toBe(false);
        expect(isSafePath('')).toBe(false);
        expect(isSafePath(null)).toBe(false);
    });
});
