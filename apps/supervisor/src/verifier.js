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

  async verify(files) {
    console.log('[Verifier] Starting pre-flight checks...');

    // File names come from `git status`, so the agent picks them. Refuse
    // anything outside the safe set before any command sees it.
    const unsafe = files.filter(file => !isSafePath(file));
    if (unsafe.length > 0) {
      throw new Error(`Unsafe file name(s), commit aborted: ${unsafe.join(', ')}`);
    }

    // Syntax check. `node --check` parses and never runs the file. It gets
    // an absolute path (no name can pass for a flag), no environment beyond
    // PATH, a cwd outside the tree, and a time limit.
    for (const file of files) {
      if (!/\.(js|mjs|cjs)$/.test(file)) continue;
      const fullPath = regularFileInside(this.workDir, file);
      if (!fullPath) continue; // deleted, or a symlink: nothing to parse
      try {
        await execFileAsync('node', ['--check', fullPath], {
          cwd: os.tmpdir(),
          env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
          timeout: 20000
        });
      } catch (error) {
        throw new Error(`Syntax Error in ${file}: ${error.stderr || error.message}`);
      }
    }

    console.log('[Verifier] Checks passed.');
    return true;
  }
}

module.exports = { Verifier, isSafePath, regularFileInside, SAFE_PATH_RE };
