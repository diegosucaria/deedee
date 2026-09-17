const child_process = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
    exec: jest.fn(),
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    })
}));

const { Verifier, isSafePath, regularFileInside } = require('../src/verifier');

describe('Verifier', () => {
    let verifier;
    let work;
    let outside;

    function write(rel, content = 'x = 1;\n') {
        const full = path.join(work, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-')));
        work = path.join(root, 'work');
        outside = path.join(root, 'outside');
        fs.mkdirSync(work);
        fs.mkdirSync(outside);
        verifier = new Verifier(work);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(path.dirname(work), { recursive: true, force: true });
    });

    test('runs node --check with the absolute path, no environment and a cwd outside the tree', async () => {
        const a = write('apps/agent/src/a.js');
        const b = write('packages/core/b.mjs');
        write('docs/notes.md');

        await verifier.verify(['apps/agent/src/a.js', 'packages/core/b.mjs', 'docs/notes.md']);

        const checks = child_process.execFile.mock.calls.filter(call => call[0] === 'node');
        expect(checks.map(call => call[1])).toEqual([['--check', a], ['--check', b]]);
        for (const [, , opts] of checks) {
            expect(opts.cwd).toBe(os.tmpdir());
            expect(Object.keys(opts.env)).toEqual(['PATH']);
            expect(opts.timeout).toBeGreaterThan(0);
        }
    });

    test('never runs npm, a test, or a shell', async () => {
        write('apps/agent/src/a.js');
        await verifier.verify(['apps/agent/src/a.js']);
        expect(child_process.exec).not.toHaveBeenCalled();
        expect(child_process.execFile.mock.calls.every(call => call[0] === 'node')).toBe(true);
    });

    test('a symlink or a deleted file is not parsed', async () => {
        fs.writeFileSync(path.join(outside, 'secret.js'), 'TOKEN=abc');
        fs.mkdirSync(path.join(work, 'apps'), { recursive: true });
        fs.symlinkSync(path.join(outside, 'secret.js'), path.join(work, 'apps/link.js'));
        fs.symlinkSync(outside, path.join(work, 'apps/dir'));

        await verifier.verify(['apps/link.js', 'apps/dir/secret.js', 'apps/gone.js']);

        expect(child_process.execFile).not.toHaveBeenCalled();
    });

    test('rejects a name with ; before running anything', async () => {
        await expect(verifier.verify(['apps/agent/src/a.js; touch /tmp/pwned.js']))
            .rejects.toThrow(/Unsafe file name/);
        expect(child_process.execFile).not.toHaveBeenCalled();
    });

    test('rejects a name with $( before running anything', async () => {
        await expect(verifier.verify(['apps/agent/src/$(id).js']))
            .rejects.toThrow(/Unsafe file name/);
        expect(child_process.execFile).not.toHaveBeenCalled();
    });

    test('reports a syntax error with the file name', async () => {
        write('apps/agent/src/bad.js');
        child_process.execFile.mockImplementationOnce((file, args, opts, cb) => {
            cb(Object.assign(new Error('exit 1'), { stderr: 'SyntaxError: Unexpected token' }));
            return { unref: () => { } };
        });

        await expect(verifier.verify(['apps/agent/src/bad.js']))
            .rejects.toThrow(/Syntax Error in apps\/agent\/src\/bad.js: SyntaxError/);
    });

    test('regularFileInside refuses links, folders and paths outside', () => {
        write('a.js');
        fs.symlinkSync(path.join(work, 'a.js'), path.join(work, 'b.js'));
        expect(regularFileInside(work, 'a.js')).toBe(path.join(work, 'a.js'));
        expect(regularFileInside(work, 'b.js')).toBeNull();
        expect(regularFileInside(work, '.')).toBeNull();
        expect(regularFileInside(work, '../outside')).toBeNull();
        expect(regularFileInside(work, 'missing.js')).toBeNull();
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
