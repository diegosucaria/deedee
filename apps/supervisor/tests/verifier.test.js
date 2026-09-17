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

const { Verifier, isSafePath, regularFileInside, readPinned, snapshotFiles } = require('../src/verifier');

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
        child_process.execFile.mockImplementation((file, args, opts, cb) => {
            cb(null, { stdout: '', stderr: '' });
            return { unref: () => { } };
        });
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

    test('runs node --check on a private copy, with no environment and a cwd outside the tree', async () => {
        write('apps/agent/src/a.js', 'a = 1;\n');
        write('packages/core/b.mjs', 'export const b = 2;\n');
        write('docs/notes.md');
        const seen = [];
        child_process.execFile.mockImplementation((file, args, opts, cb) => {
            seen.push({ args, opts, content: fs.readFileSync(args[1], 'utf8') });
            cb(null, { stdout: '', stderr: '' });
            return { unref: () => { } };
        });

        await verifier.verify(['apps/agent/src/a.js', 'packages/core/b.mjs', 'docs/notes.md']);

        expect(seen.map(c => path.basename(c.args[1]))).toEqual(['a.js', 'b.mjs']);
        expect(seen.map(c => c.content)).toEqual(['a = 1;\n', 'export const b = 2;\n']);
        for (const { args, opts } of seen) {
            expect(args[0]).toBe('--check');
            expect(args[1].startsWith(work)).toBe(false);
            expect(args[1].startsWith(os.tmpdir())).toBe(true);
            expect(opts.cwd).toBe(path.dirname(args[1]));
            expect(Object.keys(opts.env)).toEqual(['PATH']);
            expect(opts.timeout).toBeGreaterThan(0);
            // The copy is gone once the check ends.
            expect(fs.existsSync(args[1])).toBe(false);
        }
    });

    test('the copy keeps the module type of the nearest package.json', async () => {
        write('apps/web/package.json', '{"type":"module"}');
        write('apps/web/src/a.js', 'export const a = 1;\n');
        const types = [];
        child_process.execFile.mockImplementation((file, args, opts, cb) => {
            const pkg = path.join(path.dirname(args[1]), 'package.json');
            types.push(fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, 'utf8')).type : null);
            cb(null, { stdout: '', stderr: '' });
            return { unref: () => { } };
        });
        await verifier.verify(['apps/web/src/a.js']);
        expect(types).toEqual(['module']);
    });

    test('checks the snapshot bytes, not what the path holds later', async () => {
        write('apps/a.js', 'a = 1;\n');
        const snapshot = snapshotFiles(work, ['apps/a.js']);
        fs.writeFileSync(path.join(outside, 'secret.js'), 'TOKEN=abc');
        fs.rmSync(path.join(work, 'apps/a.js'));
        fs.symlinkSync(path.join(outside, 'secret.js'), path.join(work, 'apps/a.js'));
        const contents = [];
        child_process.execFile.mockImplementation((file, args, opts, cb) => {
            contents.push(fs.readFileSync(args[1], 'utf8'));
            cb(null, { stdout: '', stderr: '' });
            return { unref: () => { } };
        });
        await verifier.verify(['apps/a.js'], snapshot);
        expect(contents).toEqual(['a = 1;\n']);
    });

    test('a syntax error is scrubbed of the supervisor credentials', async () => {
        const previous = process.env.VERIFIER_TEST_TOKEN;
        process.env.VERIFIER_TEST_TOKEN = 'supervisor-secret-value';
        try {
            write('apps/bad.js');
            child_process.execFile.mockImplementationOnce((file, args, opts, cb) => {
                cb(Object.assign(new Error('exit 1'), { stderr: `${args[1]}:1\nGITHUB_PAT=supervisor-secret-value\nSyntaxError` }));
                return { unref: () => { } };
            });
            const error = await verifier.verify(['apps/bad.js']).catch(e => e);
            expect(error.message).toMatch(/^Syntax Error in apps\/bad.js: apps\/bad.js:1/);
            expect(error.message).not.toContain('supervisor-secret-value');
        } finally {
            if (previous === undefined) delete process.env.VERIFIER_TEST_TOKEN;
            else process.env.VERIFIER_TEST_TOKEN = previous;
        }
    });

    test('readPinned reads a file once and never follows a link', () => {
        write('apps/a.js', 'a();\n');
        fs.chmodSync(path.join(work, 'apps/a.js'), 0o755);
        fs.writeFileSync(path.join(outside, 'secret'), 'TOKEN=abc');
        fs.symlinkSync(path.join(outside, 'secret'), path.join(work, 'apps/link.js'));
        fs.symlinkSync(outside, path.join(work, 'apps/dir'));
        fs.mkdirSync(path.join(work, 'apps/folder'));

        expect(readPinned(work, 'apps/a.js')).toEqual({ type: 'file', data: Buffer.from('a();\n'), executable: true });
        expect(readPinned(work, 'apps/link.js')).toEqual({ type: 'symlink', target: path.join(outside, 'secret') });
        expect(readPinned(work, 'apps/dir/secret')).toEqual({ type: 'other' });
        expect(readPinned(work, 'apps/folder')).toEqual({ type: 'other' });
        expect(readPinned(work, 'apps/gone.js')).toEqual({ type: 'missing' });
        expect(readPinned(work, '../outside/secret')).toEqual({ type: 'other' });
    });

    test('readPinned refuses a FIFO without hanging', () => {
        fs.mkdirSync(path.join(work, 'apps'), { recursive: true });
        const fifo = path.join(work, 'apps/pipe.js');
        const made = jest.requireActual('child_process').spawnSync('mkfifo', [fifo]);
        if (made.status !== 0) return;
        expect(readPinned(work, 'apps/pipe.js')).toEqual({ type: 'other' });
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
