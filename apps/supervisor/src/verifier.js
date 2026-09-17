const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Characters a path may carry before it reaches `node --check` or `git add`.
// Letters, digits, `. _ / @ - + [ ]`. Brackets and plus serve Next.js route
// folders (`[id]`) and patch files; nothing here means anything to a shell,
// and no shell ever sees these names anyway.
const SAFE_PATH_RE = /^[A-Za-z0-9._/@+\[\]-]+$/;

function isSafePath(file) {
  return typeof file === 'string' && SAFE_PATH_RE.test(file);
}

/**
 * The absolute path of `file` under `root` when it is a regular file reached
 * without any symlink on the way; otherwise null. The supervisor reads files
 * the agent wrote, and a link could point at one of the supervisor's own.
 */
function regularFileInside(root, file) {
  try {
    const realRoot = fs.realpathSync(root);
    const expected = path.resolve(realRoot, file);
    const rel = path.relative(realRoot, expected);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (fs.realpathSync(expected) !== expected) return null;
    return fs.lstatSync(expected).isFile() ? expected : null;
  } catch {
    return null;
  }
}

// Largest file the supervisor reads out of the shared tree for a commit.
const MAX_PINNED_BYTES = 50 * 1024 * 1024;

/** The path the kernel reports for an open descriptor, or null off Linux. */
function descriptorPath(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Reads one entry of the shared tree once, so that every later step (secret
 * scan, syntax check, commit) works on the same bytes and never opens the
 * agent's path by name again. The agent can swap a file for a symlink at
 * any moment; a check followed by an open of the same name would follow
 * whatever link sits there by then.
 *
 * Returns one of:
 *   { type: 'file', data: Buffer, executable: boolean }
 *   { type: 'symlink', target: string }  (the link itself, never followed)
 *   { type: 'missing' }
 *   { type: 'other' }  (a folder, a device, a path through a link, a swap)
 */
function readPinned(root, file, { maxBytes = MAX_PINNED_BYTES } = {}) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { type: 'missing' };
  }
  const expected = path.resolve(realRoot, file);
  const rel = path.relative(realRoot, expected);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { type: 'other' };

  // Every folder on the way must be a real folder, not a link.
  const dirOk = () => {
    try {
      return fs.realpathSync(path.dirname(expected)) === path.dirname(expected);
    } catch {
      return false;
    }
  };

  let stat;
  try {
    stat = fs.lstatSync(expected);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { type: 'missing' };
    return { type: 'other' };
  }
  if (!dirOk()) return { type: 'other' };

  if (stat.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(expected);
      return dirOk() ? { type: 'symlink', target } : { type: 'other' };
    } catch {
      return { type: 'other' };
    }
  }
  if (!stat.isFile()) return { type: 'other' };

  // O_NOFOLLOW refuses a link in the last place; O_NONBLOCK keeps a FIFO
  // from hanging the open. The descriptor then pins the file: fstat and the
  // kernel's own path for it must still match what the name led to.
  let fd;
  try {
    fd = fs.openSync(expected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
  } catch {
    return { type: 'other' };
  }
  try {
    const pinned = fs.fstatSync(fd);
    if (!pinned.isFile()) return { type: 'other' };
    const opened = descriptorPath(fd);
    if (opened !== null && opened !== expected) return { type: 'other' };
    if (opened === null && (pinned.dev !== stat.dev || pinned.ino !== stat.ino || !dirOk())) return { type: 'other' };
    if (pinned.size > maxBytes) {
      throw new Error(`${file} is larger than ${maxBytes} bytes.`);
    }
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`${file} is larger than ${maxBytes} bytes.`);
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    return { type: 'file', data: Buffer.concat(chunks), executable: (pinned.mode & 0o100) !== 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads every listed path once. Returns Map<file, readPinned result>. */
function snapshotFiles(root, files) {
  const snapshot = new Map();
  for (const file of files) snapshot.set(file, readPinned(root, file));
  return snapshot;
}

// Names of this process's variables that hold credentials.
const SECRET_ENV_NAME = /TOKEN|SECRET|PASS|KEY|CREDENTIAL|AUTH|COOKIE|PRIVATE|(?:^|_)PAT(?:_|$)/i;

/**
 * Replaces the value of every credential-named variable of this process.
 * Anything the supervisor hands back to the agent passes through here.
 */
function scrubProcessSecrets(text, env = process.env) {
  let out = String(text ?? '');
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 6)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join('[REDACTED]');
  }
  return out;
}

/**
 * The "type" of the package.json nearest to `file`, read from the snapshot
 * reader so no name is followed. Decides how node parses a .js file.
 */
function packageType(root, file) {
  let dir = path.posix.dirname(file);
  for (;;) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const entry = readPinned(root, candidate, { maxBytes: 1024 * 1024 });
    if (entry.type === 'file') {
      try {
        const type = JSON.parse(entry.data.toString('utf8')).type;
        return type === 'module' || type === 'commonjs' ? type : null;
      } catch {
        return null;
      }
    }
    if (dir === '.' || dir === '/' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

const MAX_ERROR_CHARS = 2000;

/**
 * Checks a change before it becomes a pull request, without running any of
 * its code. The old verifier ran `npm test` in the shared tree; the agent
 * writes that tree as root, so a test file was code the supervisor ran with
 * the Docker socket in reach. Tests now run in CI on the pull request.
 */
class Verifier {
  constructor(workDir = '/app/source') {
    this.workDir = workDir;
  }

  /**
   * @param {string[]} files
   * @param {Map} [snapshot] - bytes read once by snapshotFiles(); read here when absent
   */
  async verify(files, snapshot = null) {
    console.log('[Verifier] Starting pre-flight checks...');

    // File names come from `git status`, so the agent picks them. Refuse
    // anything outside the safe set before any command sees it.
    const unsafe = files.filter(file => !isSafePath(file));
    if (unsafe.length > 0) {
      throw new Error(`Unsafe file name(s), commit aborted: ${unsafe.join(', ')}`);
    }

    // Syntax check. `node --check` parses and never runs the file. It never
    // sees the shared tree: it gets a private copy of the bytes read once,
    // in a folder of this container only, with no environment beyond PATH
    // and a time limit.
    const jsFiles = files.filter(file => /\.(js|mjs|cjs)$/.test(file));
    if (jsFiles.length === 0) {
      console.log('[Verifier] Checks passed.');
      return true;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-verify-'));
    try {
      for (const file of jsFiles) {
        const entry = snapshot && snapshot.has(file) ? snapshot.get(file) : readPinned(this.workDir, file);
        if (!entry || entry.type !== 'file') continue; // deleted, a link or not a file: nothing to parse

        const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
        const type = /\.js$/.test(file) ? packageType(this.workDir, file) : null;
        if (type) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type }));
        const copy = path.join(dir, path.basename(file));
        fs.writeFileSync(copy, entry.data, { mode: 0o600 });
        try {
          await execFileAsync('node', ['--check', copy], {
            cwd: dir,
            env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
            timeout: 20000
          });
        } catch (error) {
          const detail = String(error.stderr || error.message).split(copy).join(file);
          throw new Error(`Syntax Error in ${file}: ${scrubProcessSecrets(detail).slice(0, MAX_ERROR_CHARS)}`);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log('[Verifier] Checks passed.');
    return true;
  }
}

module.exports = {
  Verifier,
  isSafePath,
  regularFileInside,
  readPinned,
  snapshotFiles,
  scrubProcessSecrets,
  SAFE_PATH_RE
};
