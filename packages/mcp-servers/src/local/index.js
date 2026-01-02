const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const BLOCKED_BINARIES = [
  'vi', 'nano', 'emacs', 'vim', 'top', 'htop', 'shutdown', 'init', 'halt',
  'passwd', 'rm', 'mkfs', 'fdisk', 'parted', 'dd', 'env', 'sudo', 'su'
];

class LocalTools {
  constructor(workDir = '/app') {
    this.workDir = workDir;
  }

  async readFile(filePath) {
    try {
      const fullPath = path.resolve(this.workDir, filePath);
      return await fs.readFile(fullPath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  async writeFile(filePath, content) {
    try {
      const fullPath = path.resolve(this.workDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
      return { success: true, path: fullPath };
    } catch (error) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  async listDirectory(dirPath) {
    try {
      const fullPath = path.resolve(this.workDir, dirPath);
      const files = await fs.readdir(fullPath, { withFileTypes: true });
      return files.map(dirent => ({
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file'
      }));
    } catch (error) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  async runShellCommand(command) {
    // Basic validation to prevent running interactive tools that hang or highly destructive commands
    const binary = command.trim().split(' ')[0];

    const binaryName = path.basename(binary);

    if (BLOCKED_BINARIES.includes(binaryName)) {
      throw new Error(`Command '${binaryName}' is blocked for security or stability reasons.`);
    }

    try {
      console.log(`[LocalTools] Executing: ${command}`);
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workDir,
        timeout: 30000 // 30s timeout
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
