const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const BLOCKED_BINARIES = [
  'vi', 'nano', 'emacs', 'vim', 'top', 'htop', 'shutdown', 'init', 'halt',
  'passwd', 'mkfs', 'fdisk', 'parted', 'dd', 'env', 'sudo', 'su',
  'sqlite3'
];

// Patterns that indicate direct database access — use the proper tools instead
const BLOCKED_PATTERNS = [
  { regex: /\.db\b/, message: "Direct database file access is not allowed. Use the appropriate tools (list_vinyls, get_vinyl, search_vinyls, etc.) instead." },
  { regex: /agent\.db/, message: "Direct access to agent.db is not allowed. Use the appropriate tools instead." },
  { regex: /\bstrings\s+.*\/app\/data/i, message: "Raw binary extraction from data files is not allowed." },
  { regex: /\/app\/interfaces-data/i, message: "Access to the interfaces data volume is not allowed. It contains credentials and session data." },
];

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
      return await fs.readFile(fullPath, 'utf8');
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
        timeout: options.timeout || 30000 // default 30s
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      // If the command failed (exit code != 0), we still return the output
      // so the model can see why it failed.
      return {
        stdout: error.stdout ? error.stdout.trim() : '',
        stderr: error.stderr ? error.stderr.trim() : error.message,
        error: true
      };
    }
  }
}

module.exports = { LocalTools };
