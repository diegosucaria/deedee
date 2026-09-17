const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const BLOCKED_BINARIES = [
  'vi', 'nano', 'emacs', 'vim', 'top', 'htop', 'shutdown', 'init', 'halt',
  'passwd', 'mkfs', 'fdisk', 'parted', 'dd', 'env', 'printenv', 'sudo', 'su',
  'sqlite3'
];

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
// goes; see isSecretName.
const SECRET_LINE = /^(\s*(?:export\s+)?)(["']?[A-Za-z0-9_.-]+["']?)(\s*[=:]\s*)(?!\[REDACTED)(\S.*)$/gm;

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
function redactSecrets(text, env = process.env) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  const values = Object.entries(env)
    .filter(([name, value]) => isSecretName(name) && typeof value === 'string' && value.length >= 6)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = out.replace(SECRET_LINE, (line, prefix, name, separator) => (
    isSecretName(name) ? `${prefix}${name}${separator}[REDACTED]` : line
  ));
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

class LocalTools {
  constructor(workDir = '/app') {
    this.workDir = workDir;
  }

  _resolveSafe(targetPath) {
    const fullPath = path.resolve(this.workDir, targetPath);
    if (!fullPath.startsWith(path.resolve(this.workDir))) {
      throw new Error(`Access denied: Path '${targetPath}' resolves outside of working directory.`);
    }
    return fullPath;
  }

  async readFile(filePath) {
    try {
      const fullPath = this._resolveSafe(filePath);
      return redactSecrets(await fs.readFile(fullPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  async writeFile(filePath, content) {
    try {
      const fullPath = this._resolveSafe(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
      return { success: true, path: fullPath };
    } catch (error) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  async listDirectory(dirPath) {
    try {
      const fullPath = this._resolveSafe(dirPath);
      const files = await fs.readdir(fullPath, { withFileTypes: true });
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
    const binary = command.trim().split(' ')[0];

    const binaryName = path.basename(binary);

    if (BLOCKED_BINARIES.includes(binaryName)) {
      throw new Error(`Command '${binaryName}' is blocked for security or stability reasons.`);
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

module.exports = { LocalTools, redactSecrets, isSecretName, shellEnv, SHELL_BASE_VARS, BLOCKED_PATTERNS };
