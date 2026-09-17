const fs = require('fs/promises');
const path = require('path');
const { exec, execFile } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

const BLOCKED_BINARIES = [
  'vi', 'nano', 'emacs', 'vim', 'top', 'htop', 'shutdown', 'init', 'halt',
  'passwd', 'mkfs', 'fdisk', 'parted', 'dd', 'env', 'printenv', 'sudo', 'su',
  'sqlite3'
];

// Words that run the next word as a command. `sh -c '<script>'` runs its
// script. Checking only the first word of the whole line let
// `sh -c env`, `cd x && vi` or `nohup top` through.
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh']);
// Programs that run the string after -c: `flock /tmp/l -c env`, `script -c env`.
const C_FLAG_WRAPPERS = new Set([...SHELL_WRAPPERS, 'flock', 'script']);
const PREFIX_WRAPPERS = new Set([
  'nohup', 'exec', 'time', 'nice', 'timeout', 'xargs', 'command', 'busybox', 'stdbuf',
  'setsid', 'unshare', 'nsenter', 'ionice', 'chroot', 'flock', 'taskset', 'chrt'
]);
// Wrappers whose first plain argument is not the command: `chroot /dir env`,
// `flock /tmp/lock env`, `taskset 0x1 env`, `chrt 10 env`.
const ARG_WRAPPERS = new Set(['chroot', 'flock', 'taskset', 'chrt']);
// Shell words that sit where a command name goes but are not programs.
const RESERVED_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac',
  '{', '}', '!', '[[', ']]', 'coproc'
]);
// Words that start a line whose other words are not commands:
// `for i in a b`, `select x in a b`, `case $x in`.
const LIST_WORDS = new Set(['for', 'select', 'case']);

/**
 * Splits a command line into simple commands: one array of words per
 * command, split at ; & | ( ) ` and newlines outside quotes. Quoted text
 * stays inside its word. Redirect targets (`>file`, `2>&1`, `</dev/null`)
 * are not words. Heredoc bodies are data: they are skipped up to their
 * closing line, and parsing goes on after it.
 */
function splitSimpleCommands(command) {
  const text = String(command);
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  // What the next finished word is: a redirect target, a heredoc delimiter,
  // or a normal word.
  let nextWord = null;
  let pendingHeredocs = [];
  const endWord = () => {
    if (inWord) {
      if (nextWord === 'target') {
        nextWord = null;
      } else if (nextWord === 'heredoc') {
        pendingHeredocs.push(word);
        nextWord = null;
      } else {
        words.push(word);
      }
    }
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (nextWord === 'target') nextWord = null;
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      inWord = true;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length) i++;
        word += text[i];
      }
    } else if (ch === '\\') {
      if (i + 1 < text.length) {
        i++;
        if (text[i] !== '\n') word += text[i];
      }
      inWord = true;
    } else if (ch === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      // Here-string: the next word is data.
      endWord();
      nextWord = 'target';
      i += 2;
    } else if (ch === '<' && text[i + 1] === '<') {
      endWord();
      nextWord = 'heredoc';
      i++;
      if (text[i + 1] === '-') i++;
    } else if ((ch === '<' || ch === '>') && text[i + 1] !== '(') {
      // A file descriptor number glued to the redirect is not a word.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      while (i + 1 < text.length && '<>&|'.includes(text[i + 1])) i++;
      nextWord = 'target';
    } else if (ch === '<' || ch === '>') {
      // Process substitution `<(cmd)`: the `(` starts a command.
      endWord();
    } else if (ch === '\n') {
      endCommand();
      if (pendingHeredocs.length) {
        // Skip each body up to the line that closes it.
        let lineStart = i + 1;
        for (const delimiter of pendingHeredocs) {
          for (;;) {
            if (lineStart >= text.length) break;
            let lineEnd = text.indexOf('\n', lineStart);
            if (lineEnd === -1) lineEnd = text.length;
            const line = text.slice(lineStart, lineEnd).replace(/^\t+/, '');
            lineStart = lineEnd + 1;
            if (line === delimiter) break;
          }
        }
        pendingHeredocs = [];
        i = lineStart - 1;
      }
    } else if (';&|()`'.includes(ch)) {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * The program name of every command the line would start, looking through
 * wrappers and shell keywords: `nohup top`, `timeout 5 vi`, `bash -c "env"`,
 * `if true; then sudo id; fi`. Guard rail only; `node -e` or `python -c`
 * can start anything and are not parsed.
 */
function commandHeads(command, depth = 0) {
  const heads = [];
  for (const words of splitSimpleCommands(command)) {
    let i = 0;
    while (i < words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || RESERVED_WORDS.has(words[i])) {
        i++;
      } else if (words[i] === 'function') {
        i += 2;
      } else {
        break;
      }
    }
    if (i < words.length && LIST_WORDS.has(words[i])) continue;
    while (i < words.length) {
      const name = path.basename(words[i]);
      const cFlag = C_FLAG_WRAPPERS.has(name)
        ? words.findIndex((w, k) => k > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w))
        : -1;
      if (cFlag !== -1 && cFlag + 1 < words.length) {
        heads.push(name);
        if (depth < 3) heads.push(...commandHeads(words[cFlag + 1], depth + 1));
        break;
      }
      if (PREFIX_WRAPPERS.has(name)) {
        // `command -v vi` asks where vi is; it does not run it.
        if (name === 'command' && words.slice(i + 1).some(w => /^-[a-zA-Z]*[vV]/.test(w))) {
          heads.push(name);
          break;
        }
        i++;
        const skipFlags = () => { while (i < words.length && /^-/.test(words[i])) i++; };
        if (ARG_WRAPPERS.has(name)) {
          // Flags, the one argument, then flags again.
          skipFlags();
          i++;
          skipFlags();
        } else {
          while (i < words.length && (/^-/.test(words[i]) || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]))) i++;
        }
        continue;
      }
      heads.push(name);
      break;
    }
  }
  return heads;
}

// Subfolders of the data volume the shell may read. Everything else there —
// the browser profile and its secrets file, the WhatsApp session, the Google
// credentials, the databases — holds credentials or personal data. A glob or
// a `..` hop from an open folder can point at those, so a path that carries
// either counts as a hit.
const DATA_DIR_PATH = /\/app\/data(?![\w-])(\/[^\s"';|&)>]*)?/gi;
const DATA_DIR_OPEN = /^\/(?:output|journal|vaults|vinyl_covers|wardrobe)(?:\/|$)/i;

/** True when a command names a path under /app/data that is not open. */
function touchesProtectedData(command) {
  const hits = String(command).match(DATA_DIR_PATH);
  if (!hits) return false;
  return hits.some((hit) => {
    const rest = hit.slice('/app/data'.length);
    if (!rest) return true;
    if (/[*?[\]{}]/.test(rest) || rest.includes('..')) return true;
    return !DATA_DIR_OPEN.test(rest);
  });
}

// Commands the shell refuses. These read the command text, so they are a
// guard rail and not a boundary: the child runs as root, and a command that
// spells a path in another way still gets through. The confirmation manager
// reads the same list, so both layers agree.
const BLOCKED_PATTERNS = [
  { match: (c) => /\.db\b/.test(c), message: "Direct database file access is not allowed. Use the appropriate tools (list_vinyls, get_vinyl, search_vinyls, etc.) instead." },
  { match: (c) => /agent\.db/.test(c), message: "Direct access to agent.db is not allowed. Use the appropriate tools instead." },
  { match: (c) => /\bstrings\s+.*\/app\/data/i.test(c), message: "Raw binary extraction from data files is not allowed." },
  { match: (c) => /\/app\/interfaces-data/i.test(c), message: "Access to the interfaces data volume is not allowed. It contains credentials and session data." },
  { match: touchesProtectedData, message: "That path in the data volume holds credentials or personal data. Only output/, journal/, vaults/, vinyl_covers/ and wardrobe/ are open, and only without globs." },
  { match: (c) => /browser[_-](?:profile|secrets)/i.test(c), message: "Access to the browser profile and its secrets file is not allowed." },
  { match: (c) => /(?:^|[^\w])proc\//i.test(c), message: "Reading /proc is not allowed. Process environments there hold credentials." },
  { match: (c) => /\benviron\b/i.test(c), message: "Reading process environments is not allowed. They hold credentials." },
];

// Names that hold credentials. The words match anywhere in the name, so
// GOOGLE_API_KEY and Authorization both count. PAT is the exception: it has
// to stand on its own, because as a substring it turns "path", "paths",
// "patch" and "compatible" into [REDACTED] and wrecks the files the agent
// reads.
const SECRET_NAME = /PASS|PWD|TOKEN|SECRET|KEY|CREDENTIAL|COOKIE|AUTH|PRIVATE|WEBHOOK|(?:^|[^A-Za-z])PAT(?:[^A-Za-z]|$)/i;

// Ordinary names the words above catch by accident. "Authorization" is not
// one of them and stays redacted.
const BENIGN_NAME = /^["']?(?:authors?|monkeys?)["']?$/i;

/** True when a variable or field name looks like it holds a credential. */
function isSecretName(name) {
  return typeof name === 'string' && SECRET_NAME.test(name) && !BENIGN_NAME.test(name);
}

// A `NAME=value` or `NAME: value` line. The name decides whether the value
// goes; see isSecretName. The gap around `=` or `:` must stay on the line:
// if it could span a newline, a block key such as `env:` would match with the
// next line as its value and that line would never be tested on its own.
const SECRET_LINE = /^([ \t]*(?:export[ \t]+)?)(["']?[A-Za-z0-9_.-]+["']?)([ \t]*[=:][ \t]*)(?!\[REDACTED)(\S.*)$/gm;

// Credential shapes that no environment variable of this process holds, so
// value matching cannot find them: GitHub tokens (fine-grained and classic)
// and any URL that carries a user or password.
const SECRET_PATTERNS = [
  // A URL that carries a user or a password: https://<token>@github.com/...
  { regex: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, replacement: '$1[REDACTED]@' },
  { regex: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED]' },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED]' },
];

// The child of runShellCommand starts from these variables only. Everything
// else — every provider key — stays in this process, so `curl -d "$KEY"`
// sends nothing. The child still runs as root and shares the host's /proc,
// so this cuts the easy paths to a credential, not every path.
const SHELL_BASE_VARS = ['PATH', 'HOME', 'TZ', 'LANG'];
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Environment for a shell command: the base variables plus the names listed
 * in SHELL_ENV_PASSTHROUGH (comma or space separated), and nothing else.
 */
function shellEnv(env = process.env) {
  const out = {};
  for (const name of SHELL_BASE_VARS) {
    if (typeof env[name] === 'string' && env[name] !== '') out[name] = env[name];
  }
  if (!out.PATH) out.PATH = DEFAULT_PATH;
  const extra = String(env.SHELL_ENV_PASSTHROUGH || '').split(/[\s,]+/).filter(Boolean);
  for (const name of extra) {
    if (name === 'SHELL_ENV_PASSTHROUGH') continue;
    if (typeof env[name] === 'string') out[name] = env[name];
  }
  return out;
}

/**
 * Removes credentials from tool output before it reaches the model, logs or DB.
 * Replaces the value of every secret-named environment variable wherever it
 * appears, and the value side of "NAME=value" / "NAME: value" lines whose name
 * looks secret (covers .env files and variables this process doesn't have).
 */
// Variables whose names match SECRET_NAME but whose values are never
// secrets. The shell exports PWD and OLDPWD as the current and previous
// directory; redacting them turned every source line naming /app/apps/agent
// into a marker the agent could not write back.
const NON_SECRET_VALUE_NAMES = new Set(['PWD', 'OLDPWD']);

function redactSecrets(text, env = process.env, { lineRules = true } = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  const values = Object.entries(env)
    .filter(([name, value]) => !NON_SECRET_VALUE_NAMES.has(name) && isSecretName(name) && typeof value === 'string' && value.length >= 6)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  if (lineRules) {
    out = out.replace(SECRET_LINE, (line, prefix, name, separator) => (
      isSecretName(name) ? `${prefix}${name}${separator}[REDACTED]` : line
    ));
  }
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

// Path segments the file tools never write under. `.git/` holds hooks and
// config that git runs; `.github/` holds workflows that CI runs with the
// repository's secrets.
const WRITE_DENIED_SEGMENTS = ['.git', '.github'];

// A read that went through the redactor carries this marker. Writing it back
// would replace real lines with the marker, so writeFile refuses it.
const REDACTION_MARKER = '[REDACTED';

// Flags for the one git command the file tools run (is this path tracked?).
// No hook, no fsmonitor, no system config: the tree belongs to the agent.
const SAFE_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** How many times `needle` occurs in `text`. */
function countOf(text, needle) {
  return String(text).split(needle).length - 1;
}

/** True when `child` is `root` or sits below it. Both must be absolute. */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * realpath of the path, or of its nearest existing ancestor with the missing
 * tail joined back on. A file that does not exist yet resolves through the
 * symlinks of the folders above it.
 */
async function realpathNearest(fullPath) {
  const missing = [];
  let current = fullPath;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      // A link whose target is missing: realpath fails, but a write would
      // follow the link and create the target, wherever it points.
      const link = await fs.lstat(current).catch(() => null);
      if (link && link.isSymbolicLink()) {
        throw new Error(`Access denied: '${current}' is a link to a missing target.`);
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

class LocalTools {
  /**
   * @param {string} workDir - Relative paths resolve here.
   * @param {object} [options]
   * @param {string[]} [options.allowedRoots] - Folders the file tools may
   *   reach. Defaults to workDir alone.
   */
  constructor(workDir = '/app', options = {}) {
    this.workDir = workDir;
    // (relative path) => Promise<boolean>. On the device the supervisor
    // answers from its own index. Without it, git in the tree answers, which
    // is fine for tests and local runs but is an index the shell can write.
    this.isTrackedFn = typeof options.isTracked === 'function' ? options.isTracked : null;
    this.allowedRoots = options.allowedRoots && options.allowedRoots.length
      ? options.allowedRoots
      : [workDir];
  }

  /**
   * Resolves a path the way the kernel will: through every symlink. The check
   * runs on the real path, so a link inside the tree that points at / (or
   * anywhere else) is refused. Returns { fullPath, realPath, root, relative }.
   * This is a guard for the file tools, not a boundary against the shell,
   * which can still move a link between this check and the open.
   */
  async _resolveSafe(targetPath) {
    if (typeof targetPath !== 'string' || targetPath === '') {
      throw new Error('Access denied: a path is required.');
    }
    const fullPath = path.resolve(this.workDir, targetPath);
    const realPath = await realpathNearest(fullPath);
    for (const root of this.allowedRoots) {
      let realRoot;
      try {
        realRoot = await fs.realpath(path.resolve(root));
      } catch {
        continue;
      }
      if (isInside(realRoot, realPath)) {
        return { fullPath, realPath, root: realRoot, relative: path.relative(realRoot, realPath) };
      }
    }
    throw new Error(`Access denied: Path '${targetPath}' resolves outside of working directory.`);
  }

  /**
   * True when git tracks this path. Tracked source skips the redactor's line
   * rules, which turn ordinary code into [REDACTED] that a read-modify-write
   * would store. Any failure (no git, no repo, no answer) counts as
   * untracked, so the output gets every rule.
   */
  async _isTracked(root, relative) {
    if (!relative || relative.split(path.sep).some(seg => seg.toLowerCase() === '.git')) return false;
    if (this.isTrackedFn) {
      try {
        const realWorkDir = await fs.realpath(path.resolve(this.workDir));
        if (root !== realWorkDir) return false;
        return (await this.isTrackedFn(relative.split(path.sep).join('/'))) === true;
      } catch {
        return false;
      }
    }
    try {
      await execFileAsync('git', [
        ...SAFE_GIT_FLAGS, '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', relative
      ], {
        cwd: root,
        env: { ...shellEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        timeout: 5000
      });
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath) {
    try {
      const { realPath, root, relative } = await this._resolveSafe(filePath);
      const content = await fs.readFile(realPath, 'utf8');
      // Secret values and token shapes go from every file. Only the
      // name-based line rules are skipped for tracked source.
      const tracked = await this._isTracked(root, relative);
      return redactSecrets(content, process.env, { lineRules: !tracked });
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  async writeFile(filePath, content) {
    try {
      const { realPath, relative } = await this._resolveSafe(filePath);
      const segments = relative.split(path.sep).map(seg => seg.toLowerCase());
      const denied = WRITE_DENIED_SEGMENTS.find(name => segments.includes(name));
      if (denied) {
        throw new Error(`Access denied: writing under ${denied}/ is not allowed.`);
      }
      if (typeof content === 'string' && content.includes(REDACTION_MARKER)) {
        // Refuse only markers the file on disk does not hold already. A file
        // that quotes the marker (the redactor, its tests, the docs) can
        // still be rewritten; a redacted read written back adds markers.
        const current = await fs.readFile(realPath, 'utf8').catch(() => '');
        if (countOf(content, REDACTION_MARKER) > countOf(current, REDACTION_MARKER)) {
          throw new Error('The content holds more [REDACTED] markers than the file on disk, so it likely came from a redacted read. Writing it would replace real lines. Rewrite those lines, or edit the file with a command that changes only the lines you mean to change.');
        }
      }
      await fs.mkdir(path.dirname(realPath), { recursive: true });
      await fs.writeFile(realPath, content, 'utf8');
      return { success: true, path: realPath };
    } catch (error) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  async listDirectory(dirPath) {
    try {
      const { realPath } = await this._resolveSafe(dirPath);
      const files = await fs.readdir(realPath, { withFileTypes: true });
      return files.map(dirent => ({
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file'
      }));
    } catch (error) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  async runShellCommand(command, options = {}) {
    // Basic validation to prevent running interactive tools that hang or highly destructive commands
    const blocked = commandHeads(command).find(name => BLOCKED_BINARIES.includes(name));
    if (blocked) {
      throw new Error(`Command '${blocked}' is blocked for security or stability reasons.`);
    }

    // Block commands that target credentials or the databases directly
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.match(command)) {
        throw new Error(pattern.message);
      }
    }

    try {
      console.log(`[LocalTools] Executing: ${command}`);
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workDir,
        env: shellEnv(),
        timeout: options.timeout || 30000 // default 30s
      });
      return { stdout: redactSecrets(stdout.trim()), stderr: redactSecrets(stderr.trim()) };
    } catch (error) {
      // If the command failed (exit code != 0), we still return the output
      // so the model can see why it failed.
      return {
        stdout: error.stdout ? redactSecrets(error.stdout.trim()) : '',
        stderr: redactSecrets(error.stderr ? error.stderr.trim() : error.message),
        error: true
      };
    }
  }
}

module.exports = { LocalTools, commandHeads, redactSecrets, isSecretName, shellEnv, SHELL_BASE_VARS, BLOCKED_PATTERNS };
