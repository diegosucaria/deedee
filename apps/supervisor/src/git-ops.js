const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { Verifier, isSafePath, regularFileInside } = require('./verifier');
const execFileAsync = util.promisify(execFile);

// Untracked files may only enter a commit from these folders, with these
// extensions (or the bare name `Dockerfile`). Root-level files, data/ and
// *.db never get staged. This keeps personal files the agent drops into the
// work dir out of the public repo.
const ALLOWED_PREFIXES = ['apps/', 'packages/', 'docs/', 'specs/'];
const ALLOWED_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml',
  '.py', '.txt', '.css', '.sh', '.svg', '.png'
];
const ALLOWED_BASENAMES = ['Dockerfile'];

// No change under these folders ever goes out, tracked or not. A workflow
// file on a branch of this repository runs in CI with the repository's
// secrets as soon as a pull request opens.
const DENIED_SEGMENTS = ['.git', '.github'];

// Every git command carries these. The supervisor keeps its own git dir, so
// the repository config is its own; the flags still switch off everything in
// git that starts another program, in case that config is ever shared again.
const SAFE_GIT_FLAGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.ext.allow=never'
];

// A parent process (a git hook, for one) may export these to point git at
// another repository. GitOps must only ever touch its own git dir.
const REDIRECTING_GIT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR'
];

const SELF_PR_FILE = 'self-pull-requests.json';
const MAX_RECORDED_PRS = 50;
const GITHUB_API = 'https://api.github.com';

/** process.env without the variables that redirect git away from cwd. */
function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of REDIRECTING_GIT_VARS) delete env[key];
  return env;
}

/** Environment for every git command: no system or global config, no prompt. */
function gitEnv(extra = {}) {
  return {
    ...cleanGitEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra
  };
}

/**
 * Splits credentials off a remote URL: `https://token@host/x` becomes
 * `https://host/x` plus the token. Returns { url, token }.
 */
function splitRemoteCredentials(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl) return { url: remoteUrl, token: null };
  const match = remoteUrl.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@(.*)$/i);
  if (!match) return { url: remoteUrl, token: null };
  const [, scheme, credentials, rest] = match;
  // Either "token" or "user:token"; the token is what git sends as the password.
  const token = credentials.includes(':') ? credentials.split(':').slice(1).join(':') : credentials;
  return { url: `${scheme}${rest}`, token: token || null };
}

/** `owner/repo` for an https GitHub URL, or null. */
function githubSlug(url) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** UTC time as 20260917-090312, for branch names. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
}

/** True when any segment of the path is .git or .github (any case). */
function hasDeniedSegment(file) {
  return String(file).replace(/\\/g, '/').split('/')
    .some(segment => DENIED_SEGMENTS.includes(segment.toLowerCase()));
}

/**
 * Git for the supervisor.
 *
 * The work tree (/app/source) belongs to the agent, which writes it as root.
 * So the supervisor never runs anything from it: it keeps its own git dir in
 * the supervisor-only state volume (hooks, config and index the agent cannot
 * reach), runs no tests, and never pushes to master. A self-improvement
 * becomes a branch `deedee/self/<time>` and a pull request; CI runs the suite
 * and the owner merges. A rollback becomes a revert pull request.
 */
class GitOps {
  constructor(workDir = '/app/source', identity = null, options = {}) {
    this.workDir = workDir;
    this.stateDir = options.stateDir || process.env.SUPERVISOR_STATE_DIR || '/app/state';
    this.gitDir = options.gitDir || path.join(this.stateDir, 'repo.git');
    this.fetch = options.fetch || ((...args) => fetch(...args));
    // `owner/repo` for the REST API. Derived from the remote URL when unset.
    this.repoSlug = options.repoSlug || null;
    this.verifier = new Verifier(workDir);
    // The GitHub token never enters a stored remote URL. Network commands
    // carry it as a per-command header; the REST API gets it as a bearer.
    this.token = null;
    // The remote URL configure() was given, without credentials.
    this.remoteUrl = null;
    this.identity = identity || {
      name: process.env.GIT_USER_NAME || 'Deedee Supervisor',
      email: process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot'
    };
  }

  /** `-c user.name=… -c user.email=…` for commit-like commands. */
  _identityArgs() {
    return ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
  }

  /**
   * `-c http.<remote URL>.extraheader=…` for commands that talk to the
   * remote. Bound to the configured URL, so no other host ever sees it.
   */
  _authArgs() {
    if (!this.token || !this.remoteUrl) return [];
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    return ['-c', `http.${this.remoteUrl}.extraheader=Authorization: Basic ${basic}`];
  }

  /** The configured URL. Remote commands never go by the name `origin`. */
  _remoteTarget() {
    if (this.remoteUrl) return this.remoteUrl;
    throw new Error('No remote URL is configured.');
  }

  /** Replaces the token and its base64 form wherever they appear. */
  _scrub(text) {
    let out = String(text ?? '');
    if (this.token) {
      const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
      out = out.split(this.token).join('[REDACTED]').split(basic).join('[REDACTED]');
    }
    return out.replace(/(Authorization: [A-Za-z]+ )\S+/g, '$1[REDACTED]');
  }

  /**
   * Runs git against the supervisor's own git dir and the shared work tree.
   * No shell; every argument is one argv entry. Errors never carry the token.
   * @param {string[]} args
   * @param {object} [opts] - { authed, env, raw }
   */
  async git(args, { authed = false, env = {}, raw = false } = {}) {
    const argv = [
      ...SAFE_GIT_FLAGS,
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.workDir}`,
      ...(authed ? this._authArgs() : []),
      ...args
    ];
    try {
      const { stdout, stderr } = await execFileAsync('git', argv, {
        cwd: this.workDir,
        env: gitEnv(env),
        maxBuffer: 64 * 1024 * 1024
      });
      if (stderr) console.warn(`Git Warning: ${this._scrub(stderr).trim()}`);
      return raw ? stdout : stdout.trim();
    } catch (error) {
      const message = this._scrub(`${error.message}${error.stderr ? `\n${error.stderr}` : ''}`);
      console.error(`Git Error: ${message}`);
      throw new Error(message);
    }
  }

  /** The commit a revision names, or null when it does not exist. */
  async _revParse(rev) {
    try {
      return await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    } catch {
      return null;
    }
  }

  async _fetchMaster() {
    await this.git(['fetch', '-q', this._remoteTarget(), '+refs/heads/master:refs/remotes/origin/master'], { authed: true });
  }

  async configure(name, email, remoteUrl, token = null) {
    this.identity = { name, email };

    // A URL that already carries credentials (an older GIT_REMOTE_URL) gives
    // up its token here; only the clean URL is kept.
    const split = splitRemoteCredentials(remoteUrl);
    this.token = token || split.token || null;
    this.remoteUrl = split.url || null;

    fs.mkdirSync(path.dirname(this.gitDir), { recursive: true });
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      console.log(`[GitOps] Creating the supervisor's git dir at ${this.gitDir}`);
      await this.git(['init', '-q']);
    }
    await this.git(['symbolic-ref', 'HEAD', 'refs/heads/master']);

    if (!this.remoteUrl) {
      console.log('[GitOps] No remote URL configured. Skipping sync.');
      return;
    }
    console.log(`[GitOps] Remote: ${this.remoteUrl}${this.token ? ' (credentials passed per command)' : ''}`);
    await this._fetchMaster();

    if (!(await this._revParse('HEAD'))) {
      // First start with this git dir. The work tree still matches the commit
      // the old in-tree .git had checked out; start the index there so local
      // edits stay edits, then move forward like a pull.
      const base = await this._legacyBase();
      await this.git(['reset', '-q', '--mixed', base || 'refs/remotes/origin/master']);
    }
    try {
      await this.git(['merge', '--ff-only', '-q', 'refs/remotes/origin/master']);
    } catch (error) {
      console.warn(`[GitOps] Could not fast-forward the work tree to origin/master: ${error.message}`);
    }
  }

  /**
   * The commit the work tree's own .git had checked out, read as plain files
   * (nothing runs) and fetched from the remote. Null when there is none.
   */
  async _legacyBase() {
    try {
      const dotGit = path.join(this.workDir, '.git');
      const readSmall = (rel) => {
        const file = regularFileInside(dotGit, rel);
        if (!file || fs.statSync(file).size > 1024 * 1024) return null;
        return fs.readFileSync(file, 'utf8');
      };
      let head = (readSmall('HEAD') || '').trim();
      const ref = head.match(/^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/);
      if (ref && !ref[1].includes('..')) {
        head = (readSmall(ref[1]) || '').trim();
        if (!head) {
          const packed = readSmall('packed-refs') || '';
          const line = packed.split('\n').find(l => l.endsWith(` ${ref[1]}`));
          head = line ? line.split(' ')[0] : '';
        }
      }
      if (!/^[0-9a-f]{40}$/.test(head)) return null;
      if (!(await this._revParse(head))) {
        await this.git(['fetch', '-q', this._remoteTarget(), head], { authed: true });
      }
      return await this._revParse(head);
    } catch (error) {
      console.warn(`[GitOps] Could not read the work tree's previous commit: ${error.message}`);
      return null;
    }
  }

  async _scanForSecrets(files) {
    const patterns = [
      { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,}/ },
      { name: 'GitHub Token', regex: /(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/ },
      { name: 'Private Key', regex: /-----BEGIN PRIVATE KEY-----/ }, // pii-guard: allow
      { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
      { name: 'Generic High Entropy', regex: /([a-z0-9]{32,})/i }
    ];

    for (const file of files) {
      if (file === '.') continue;

      // Only a regular file reached without a symlink. A link is committed
      // as a link; following it would read whatever it points at, which
      // could be a file of this container.
      const fullPath = regularFileInside(this.workDir, file);
      if (!fullPath) continue;
      if (fs.statSync(fullPath).size > 5 * 1024 * 1024) continue;

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
    const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/')) return false;
    if (!isSafePath(normalized)) return false;
    if (hasDeniedSegment(normalized)) return false;
    const segments = normalized.split('/');
    if (segments.includes('..') || segments.includes('data')) return false;
    if (!ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;
    if (ALLOWED_BASENAMES.includes(path.basename(normalized))) return true;
    return ALLOWED_EXTENSIONS.includes(path.extname(normalized).toLowerCase());
  }

  /**
   * Parse `git status --porcelain -z` into tracked changes and untracked
   * files. Entries end in NUL, so paths arrive as they are. A rename or copy
   * sends the new path first and the old path as the next entry; only the
   * new one matters here.
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

  /** Throws unless a remote, a token and a GitHub repository are configured. */
  _requireGithub() {
    const slug = this.repoSlug || githubSlug(this.remoteUrl);
    if (!this.remoteUrl || !this.token || !slug) {
      throw new Error('Self-improvement needs GIT_REMOTE_URL (an https GitHub URL) and GITHUB_PAT.');
    }
    return slug;
  }

  /** One GitHub REST call with the token as a bearer. Errors carry no token. */
  async _github(method, apiPath, body) {
    const res = await this.fetch(`${GITHUB_API}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'deedee-supervisor',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub API ${method} ${apiPath} returned ${res.status}: ${this._scrub(text).slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * Builds a commit from a tree without touching HEAD, the index or the work
   * tree. `prepareIndex(env)` fills a throwaway index that starts from
   * `parent`. Returns the new commit, or null when the tree did not change.
   */
  async _commitFromTempIndex(parent, message, prepareIndex) {
    const indexFile = path.join(this.gitDir, `index.tmp-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(['read-tree', parent], { env });
      await prepareIndex(env);
      const tree = await this.git(['write-tree'], { env });
      const parentTree = await this.git(['rev-parse', `${parent}^{tree}`]);
      if (tree === parentTree) return null;
      return await this.git([...this._identityArgs(), 'commit-tree', tree, '-p', parent, '-m', message]);
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
  }

  /** Pushes a commit to a new branch and opens a pull request against master. */
  async _pushAndOpenPullRequest(slug, commit, branch, title, body) {
    await this.git(['push', '-q', this._remoteTarget(), `${commit}:refs/heads/${branch}`], { authed: true });
    try {
      const pr = await this._github('POST', `/repos/${slug}/pulls`, { title, head: branch, base: 'master', body });
      return { number: pr.number, url: pr.html_url };
    } catch (error) {
      throw new Error(`Pushed branch ${branch}, but could not open the pull request: ${error.message}`);
    }
  }

  // ----- Self pull request record (supervisor state volume) -----

  _selfPrFile() {
    return path.join(this.stateDir, SELF_PR_FILE);
  }

  /** Pull requests this supervisor opened for self-improvement, newest first. */
  listSelfPullRequests() {
    try {
      const list = JSON.parse(fs.readFileSync(this._selfPrFile(), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _writeSelfPullRequests(list) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this._selfPrFile(), JSON.stringify(list.slice(0, MAX_RECORDED_PRS), null, 2));
  }

  recordSelfPullRequest(entry) {
    this._writeSelfPullRequests([entry, ...this.listSelfPullRequests().filter(e => e.number !== entry.number)]);
  }

  updateSelfPullRequest(number, patch) {
    this._writeSelfPullRequests(this.listSelfPullRequests().map(e => (e.number === number ? { ...e, ...patch } : e)));
  }

  /** GET /repos/:slug/pulls/:number. */
  async getPullRequest(number) {
    const slug = this._requireGithub();
    return this._github('GET', `/repos/${slug}/pulls/${Number(number)}`);
  }

  // ----- Commands -----

  /**
   * Opens a pull request with the work tree's changes. Never pushes master,
   * never runs a test or a hook. The changes stay in the work tree.
   */
  async commitAndPush(message, files = ['.']) {
    const skipped = [];
    try {
      const slug = this._requireGithub();

      // 0. Work out what to stage. Never `git add .`.
      const trackedToStage = [];
      const untrackedToStage = [];
      const denied = [];

      if (files.includes('.')) {
        const statusOutput = await this.git(['status', '--porcelain', '-z', '--untracked-files=all'], { raw: true });
        const { tracked, untracked } = this._parseStatus(statusOutput);
        for (const file of tracked) {
          if (hasDeniedSegment(file)) denied.push(file);
          else if (isSafePath(file)) trackedToStage.push(file);
          else skipped.push(file);
        }
        for (const file of untracked) {
          if (hasDeniedSegment(file)) denied.push(file);
          else if (this.isAllowedPath(file)) untrackedToStage.push(file);
          else skipped.push(file);
        }
      } else {
        for (const file of files) {
          if (hasDeniedSegment(file)) denied.push(file);
          else if (this.isAllowedPath(file)) untrackedToStage.push(file);
          else skipped.push(file);
        }
      }

      if (denied.length > 0) {
        throw new Error(`Refusing the change: ${denied.join(', ')} ${denied.length === 1 ? 'is' : 'are'} under .git/ or .github/. Workflows and git internals never go through self-improvement. Undo those edits (pullLatestChanges resets the tree) and retry.`);
      }

      if (!files.includes('.') && untrackedToStage.length === 0) {
        throw new Error(`No file in the allowed folders to commit. Skipped: ${skipped.join(', ')}`);
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
      if (filesToScan.length === 0) throw new Error('Nothing to commit.');

      // 1. Secret scan and syntax check. Both only read files.
      await this._scanForSecrets(filesToScan);
      await this.verifier.verify(filesToScan);

      // 2. Build the commit in a throwaway index on top of HEAD.
      // --literal-pathspecs: `[id]` in a Next.js route folder is a glob to git.
      const commit = await this._commitFromTempIndex('HEAD', message, async (env) => {
        if (trackedToStage.length > 0) {
          await this.git(['--literal-pathspecs', 'add', '-u', '--', ...trackedToStage], { env });
        }
        if (untrackedToStage.length > 0) {
          await this.git(['--literal-pathspecs', 'add', '--', ...untrackedToStage], { env });
        }
      });
      if (!commit) throw new Error('Nothing to commit: the staged files match HEAD.');

      // 3. Push a branch and open the pull request.
      const branch = `deedee/self/${stamp()}`;
      const title = String(message).split('\n')[0].slice(0, 250);
      const body = [
        'Opened by the Deedee supervisor from a self-improvement request.',
        '',
        'The supervisor ran no tests: CI runs the full suite on this pull request.',
        'Nothing reaches master or the device until the owner merges.',
        '',
        'Do not merge without the owner\'s review.'
      ].join('\n');
      const pullRequest = await this._pushAndOpenPullRequest(slug, commit, branch, title, body);

      this.recordSelfPullRequest({
        number: pullRequest.number,
        branch,
        commit,
        openedAt: new Date().toISOString()
      });

      return {
        success: true,
        message: `Opened pull request #${pullRequest.number} from ${branch}. CI runs the tests and the owner reviews and merges; nothing reaches master or the device before that. The changes stay uncommitted in the work tree. After the merge, call pullLatestChanges.`,
        branch,
        commit,
        pullRequest,
        skipped
      };
    } catch (error) {
      console.error('[GitOps] Validation or Git Error:', error.message);
      return { success: false, error: error.message, skipped };
    }
  }

  /**
   * Opens a pull request that reverts a commit on master (the newest one when
   * none is named). Never pushes master: the owner merges the revert.
   * @param {object} [opts] - { commit, reason }
   */
  async rollback({ commit, reason } = {}) {
    try {
      const slug = this._requireGithub();
      if (commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(commit))) {
        throw new Error('The commit to revert must be a hash.');
      }

      await this._fetchMaster();
      const tip = await this._revParse('refs/remotes/origin/master');
      if (!tip) throw new Error('origin/master is not available.');
      const target = await this._revParse(commit || tip);
      if (!target) throw new Error(`Commit ${commit} was not found.`);
      try {
        await this.git(['merge-base', '--is-ancestor', target, tip]);
      } catch {
        throw new Error(`Commit ${target.substring(0, 7)} is not on master.`);
      }
      const parent = await this._revParse(`${target}^1`);
      if (!parent) throw new Error(`Commit ${target.substring(0, 7)} has no parent to return to.`);
      const subject = await this.git(['log', '-1', '--format=%s', target]);

      const message = `Revert "${subject}"\n\nThis reverts commit ${target}.${reason ? `\n\n${reason}` : ''}`;
      const patchFile = path.join(this.gitDir, `revert.tmp-${process.pid}-${Date.now()}.patch`);
      let revertCommit;
      try {
        const diff = await this.git(['diff', '--binary', '--no-ext-diff', '--no-textconv', parent, target], { raw: true });
        fs.writeFileSync(patchFile, diff);
        revertCommit = await this._commitFromTempIndex(tip, message, async (env) => {
          if (diff) await this.git(['apply', '--cached', '-R', patchFile], { env });
        });
      } catch (error) {
        throw new Error(`Could not build a clean revert of ${target.substring(0, 7)} on master: ${error.message}`);
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
      if (!revertCommit) throw new Error(`Reverting ${target.substring(0, 7)} changes nothing on master.`);

      const branch = `deedee/revert/${stamp()}`;
      const body = [
        `Reverts ${target} ("${subject}").`,
        reason ? `\n${reason}\n` : '',
        'Opened by the Deedee supervisor. It never pushes master: merging this pull request is the rollback.',
        '',
        'Do not merge without the owner\'s review.'
      ].join('\n');
      const pullRequest = await this._pushAndOpenPullRequest(slug, revertCommit, branch, `Revert "${subject}"`.slice(0, 250), body);

      return {
        success: true,
        message: `Opened pull request #${pullRequest.number} that reverts ${target.substring(0, 7)}. Merging it rolls the change back; nothing was pushed to master.`,
        revertCommit,
        branch,
        pullRequest
      };
    } catch (error) {
      console.error('[GitOps] Rollback Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /** Resets the work tree to origin/master. */
  async pull() {
    try {
      console.log('[GitOps] Pulling latest changes...');
      await this._fetchMaster();
      await this.git(['reset', '-q', '--hard', 'refs/remotes/origin/master']);
      return { success: true, message: 'Pulled latest changes.' };
    } catch (error) {
      console.error('[GitOps] Pull Error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = {
  GitOps,
  cleanGitEnv,
  gitEnv,
  splitRemoteCredentials,
  githubSlug,
  hasDeniedSegment,
  SAFE_GIT_FLAGS
};
