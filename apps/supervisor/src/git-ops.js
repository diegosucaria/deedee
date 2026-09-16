const { exec, execFile } = require('child_process');
const util = require('util');
const { Verifier, isSafePath } = require('./verifier');
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// Untracked files may only enter a commit from these folders, with these
// extensions (or the bare name `Dockerfile`). Root-level files, data/ and
// *.db never get staged. This keeps personal files the agent drops into the
// work dir out of the public repo. `.github/` stays out: a staged workflow
// file would run in CI with the repository's secrets.
const ALLOWED_PREFIXES = ['apps/', 'packages/', 'docs/', 'specs/'];
const ALLOWED_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml',
  '.py', '.txt', '.css', '.sh', '.svg', '.png'
];
const ALLOWED_BASENAMES = ['Dockerfile'];

// A parent process (a git hook, for one) may export these to point git at
// another repository. GitOps must only ever touch workDir, so it drops them.
const REDIRECTING_GIT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'
];

/** process.env without the variables that redirect git away from cwd. */
function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of REDIRECTING_GIT_VARS) delete env[key];
  return env;
}

class GitOps {
  constructor(workDir = '/app/source', identity = null) {
    this.workDir = workDir;
    this.verifier = new Verifier(workDir);
    // The author identity travels with every commit and revert as `-c`
    // flags. The agent can rewrite .git/config in the shared volume; the
    // env values it cannot touch.
    this.identity = identity || {
      name: process.env.GIT_USER_NAME || 'Deedee Supervisor',
      email: process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot'
    };
  }

  /** `-c user.name=… -c user.email=…` for commit-like commands. */
  _identityArgs() {
    return ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
  }

  async run(command) {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: this.workDir, env: cleanGitEnv() });
      if (stderr) console.warn(`Git Warning: ${stderr}`);
      return stdout.trim();
    } catch (error) {
      console.error(`Git Error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Like run(), but keeps stdout as is. `git status --porcelain` entries start
   * with a space for unstaged edits; trim() would eat it.
   */
  async runRaw(command) {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: this.workDir, env: cleanGitEnv() });
      if (stderr) console.warn(`Git Warning: ${stderr}`);
      return stdout;
    } catch (error) {
      console.error(`Git Error: ${error.message}`);
      throw error;
    }
  }

  async runSafe(file, args) {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: this.workDir, env: cleanGitEnv() });
      if (stderr) console.warn(`Git Warning (Safe): ${stderr}`);
      return stdout.trim();
    } catch (error) {
      console.error(`Git Error (Safe): ${error.message}`);
      throw error;
    }
  }

  async configure(name, email, remoteUrl) {
    // Initialize (idempotent) to ensure repo exists without causing 'not a git repository' errors
    await this.run('git init');
    await this.run('git checkout -B master');

    // Repo config only serves merges during `git pull`. Commits and reverts
    // carry the identity per command (see _identityArgs).
    this.identity = { name, email };
    await this.runSafe('git', ['config', 'user.name', name]);
    await this.runSafe('git', ['config', 'user.email', email]);

    if (remoteUrl) {
      // Mask Sensitive Auth Info in Logs (Robust)
      const maskedUrl = remoteUrl.replace(/:\/\/[^@]+@/, '://***@');
      console.log(`[GitOps] Configuring remote: ${maskedUrl}`);
      // Check existing remotes to avoid 'No such remote' or 'Remote already exists' errors
      const remotes = await this.run('git remote');
      if (remotes.includes('origin')) {
        await this.run(`git remote set-url origin ${remoteUrl}`);
      } else {
        await this.run(`git remote add origin ${remoteUrl}`);
      }
      // Pull after setting up the remote to ensure content is retrieved
      console.log('[GitOps] Pulling from origin/master...');
      await this.run('git pull origin master');
    } else {
      console.log('[GitOps] No remote URL configured. Skipping pull.');
    }
  }

  async _scanForSecrets(files) {
    const fs = require('fs');
    const path = require('path');

    // Patterns for secrets
    const patterns = [
      { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,}/ },
      { name: 'GitHub Token', regex: /(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/ },
      { name: 'Private Key', regex: /-----BEGIN PRIVATE KEY-----/ }, // pii-guard: allow
      { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
      { name: 'Generic High Entropy', regex: /([a-z0-9]{32,})/i }
    ];

    for (const file of files) {
      if (file === '.') {
        continue; // Handled by git status check in caller
      }

      const fullPath = path.resolve(this.workDir, file);
      if (!fs.existsSync(fullPath)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) continue; // Skip directories for now (unless recursive needed)

      const content = fs.readFileSync(fullPath, 'utf-8');

      for (const p of patterns) {
        if (p.regex.test(content)) {
          // EXCEPTION: Allow env.example, test files, git-ops itself, and package-lock.json
          if (file.includes('.example') || file.includes('.test.') || file.endsWith('git-ops.js') || file.endsWith('package-lock.json') || file.endsWith('last_boot_commit')) {
            continue;
          }
          throw new Error(`SECURITY ALERT: Found potential ${p.name} in ${file}. Commit aborted.`);
        }
      }
    }
  }

  /** True when the path starts with one of the allowed folders. */
  _underAllowedPrefix(file) {
    const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    return ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix));
  }

  /**
   * True when a path may be staged: only safe characters, inside an allowed
   * folder, with an allowed extension (or named Dockerfile), no `..`, and no
   * `data` segment.
   */
  isAllowedPath(file) {
    const path = require('path');
    const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/')) return false;
    if (!isSafePath(normalized)) return false;
    const segments = normalized.split('/');
    if (segments.includes('..') || segments.includes('data')) return false;
    if (!ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;
    if (ALLOWED_BASENAMES.includes(path.basename(normalized))) return true;
    return ALLOWED_EXTENSIONS.includes(path.extname(normalized).toLowerCase());
  }

  /**
   * Parse `git status --porcelain -z` into tracked changes and untracked
   * files. Entries end in NUL, so paths arrive as they are: no C-quoting for
   * spaces or non-ASCII. A rename or copy sends the new path first and the
   * old path as the next entry; only the new one matters here.
   */
  _parseStatus(statusOutput) {
    const tracked = [];
    const untracked = [];
    const entries = statusOutput.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === '') continue;
      const code = entry.substring(0, 2);
      const file = entry.substring(3);
      if (code.includes('R') || code.includes('C')) i++; // skip the old path
      if (code === '??') untracked.push(file);
      else tracked.push(file);
    }
    return { tracked, untracked };
  }

  async commitAndPush(message, files = ['.']) {
    const skipped = [];
    try {
      // 0. Work out what to stage. Never `git add .`.
      let trackedToStage = [];
      let untrackedToStage = [];

      if (files.includes('.')) {
        const statusOutput = await this.runRaw('git status --porcelain -z --untracked-files=all');
        const { tracked, untracked } = this._parseStatus(statusOutput);
        // Tracked files with an unsafe name stay out of the commit as well.
        for (const file of tracked) {
          if (isSafePath(file)) trackedToStage.push(file);
          else skipped.push(file);
        }
        for (const file of untracked) {
          if (this.isAllowedPath(file)) untrackedToStage.push(file);
          else skipped.push(file);
        }
      } else {
        for (const file of files) {
          if (this.isAllowedPath(file)) untrackedToStage.push(file);
          else skipped.push(file);
        }
        if (untrackedToStage.length === 0) {
          throw new Error(`No file in the allowed folders to commit. Skipped: ${skipped.join(', ')}`);
        }
      }

      if (skipped.length > 0) {
        console.warn(`[GitOps] Skipping ${skipped.length} file(s) outside the allowed paths: ${skipped.join(', ')}`);
      }

      // A skipped file inside an allowed folder is most likely part of the
      // change. Fail so the agent sees the drop instead of a partial commit.
      const dropped = skipped.filter(file => this._underAllowedPrefix(file));
      if (dropped.length > 0) {
        throw new Error(`Refusing a partial commit: ${dropped.length} file(s) under the allowed folders have an unsupported name or extension: ${dropped.join(', ')}. Rename, delete or move them, then retry.`);
      }

      const filesToScan = [...trackedToStage, ...untrackedToStage];

      // 1. Security Scan + Verifier
      await this._scanForSecrets(filesToScan);
      await this.verifier.verify(filesToScan);

      // SAFE EXECUTION: Prevent shell injection by avoiding 'git add ${files} and git commit -m "${message}"'
      // Use execFileAsync via runSafe

      // 2. Git Add: tracked changes with -u, allowed untracked files by name.
      // --literal-pathspecs: `[id]` in a Next.js route folder is a glob to git.
      if (trackedToStage.length > 0) {
        await this.runSafe('git', ['--literal-pathspecs', 'add', '-u', '--', ...trackedToStage]);
      }
      if (untrackedToStage.length > 0) {
        await this.runSafe('git', ['--literal-pathspecs', 'add', '--', ...untrackedToStage]);
      }

      // 3. Git Commit
      // Pass message as a separate argument to avoid shell interpretation
      await this.runSafe('git', [...this._identityArgs(), 'commit', '-m', message]);

      // 4. Git Push (origin master is hardcoded safe string, but consistent to use runSafe or run)
      await this.runSafe('git', ['push', 'origin', 'master']);

      return { success: true, message: 'Pushed to origin/master', skipped };

    } catch (error) {
      console.error('[GitOps] Validation or Git Error:', error.message);
      return { success: false, error: error.message, skipped };
    }
  }

  /**
   * Revert HEAD and push. With `expectedHead`, refuse when HEAD moved: the
   * monitor only ever reverts the self-commit it recorded at start.
   */
  async rollback({ expectedHead } = {}) {
    try {
      if (expectedHead) {
        const head = await this.run('git rev-parse HEAD');
        if (head !== expectedHead) {
          const msg = `Rollback aborted: HEAD ${head.substring(0, 7)} is not the self-commit ${expectedHead.substring(0, 7)}.`;
          console.warn(`[GitOps] ${msg}`);
          return { success: false, error: msg };
        }
      }

      console.log('[GitOps] Rolling back last commit...');
      // Ensure clean state
      await this.run('git reset --hard HEAD');

      // Revert the last commit. This creates a new commit under our identity.
      await this.runSafe('git', [...this._identityArgs(), 'revert', '--no-edit', 'HEAD']);
      const revertCommit = await this.run('git rev-parse HEAD');

      // Push the new revert commit
      await this.runSafe('git', ['push', 'origin', 'master']);

      return { success: true, message: 'Rolled back last change successfully.', revertCommit };
    } catch (error) {
      console.error('[GitOps] Rollback Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async pull() {
    try {
      console.log('[GitOps] Pulling latest changes...');
      await this.run('git fetch origin');
      await this.run('git reset --hard origin/master'); // Force sync to origin
      return { success: true, message: 'Pulled latest changes.' };
    } catch (error) {
      console.error('[GitOps] Pull Error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = { GitOps, cleanGitEnv };
