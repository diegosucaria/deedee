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

// Patterns that indicate direct database access — use the proper tools instead
const BLOCKED_PATTERNS = [
  { regex: /\.db\b/, message: "Direct database file access is not allowed. Use the appropriate tools (list_vinyls, get_vinyl, search_vinyls, etc.) instead." },
  { regex: /agent\.db/, message: "Direct access to agent.db is not allowed. Use the appropriate tools instead." },
  { regex: /\bstrings\s+.*\/app\/data/i, message: "Raw binary extraction from data files is not allowed." },
  { regex: /\/app\/interfaces-data/i, message: "Access to the interfaces data volume is not allowed. It contains credentials and session data." },
  { regex: /\/proc\/[^\s]*\/environ/i, message: "Reading process environments is not allowed. They hold credentials." },
];

// Environment variable names that hold credentials.
const SECRET_NAME = /(PASS|PWD|TOKEN|SECRET|KEY|CREDENTIAL|COOKIE|AUTH|PRIVATE|PAT|WEBHOOK)/i;

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
// else — every provider key — stays in this process, so a command cannot read
// a credential even when it sends no output back.
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
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 6)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = out.replace(
    /^(\s*(?:export\s+)?["']?[A-Za-z0-9_.-]*(?:PASS|PWD|TOKEN|SECRET|KEY|CREDENTIAL|COOKIE|AUTH|PRIVATE|PAT|WEBHOOK)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(?!\[REDACTED)(\S.*)$/gim,
    '$1[REDACTED]'
  );
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

    // Block commands that target database files directly
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.regex.test(command)) {
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

module.exports = { LocalTools, redactSecrets, shellEnv, SHELL_BASE_VARS };
