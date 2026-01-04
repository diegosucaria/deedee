const { exec, execFile } = require('child_process');
const util = require('util');
const { Verifier } = require('./verifier');
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

class GitOps {
  constructor(workDir = '/app/source') {
    this.workDir = workDir;
    this.verifier = new Verifier(workDir);
  }

  async run(command) {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: this.workDir });
      if (stderr) console.warn(`Git Warning: ${stderr}`);
      return stdout.trim();
    } catch (error) {
      console.error(`Git Error: ${error.message}`);
      throw error;
    }
  }

  async runSafe(file, args) {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: this.workDir });
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

    await this.run(`git config user.name "${name}"`);
    await this.run(`git config user.email "${email}"`);

    if (remoteUrl) {
      // Mask Sensitive Auth Info in Logs
      const maskedUrl = remoteUrl.replace(/(github_pat_|ghp_)[a-zA-Z0-9]+@/, '***@');
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
      { name: 'Private Key', regex: /-----BEGIN PRIVATE KEY-----/ },
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
          // EXCEPTION: Allow env.example or similar?
          if (file.includes('.example') || file.includes('.test.') || file.endsWith('git-ops.js')) {
            continue;
          }
          throw new Error(`SECURITY ALERT: Found potential ${p.name} in ${file}. Commit aborted.`);
        }
      }
    }
  }

  async commitAndPush(message, files = ['.']) {
    try {
      // 0. Security Scan
      // If files=['.'], we need to know WHICH files are staged/changed.
      // git status --porcelain
      let filesToScan = files;
      if (files.includes('.')) {
        const statusOutput = await this.run('git status --porcelain');
        // Parse status lines: " M apps/file.js" -> "apps/file.js"
        filesToScan = statusOutput.split('\n')
          .filter(line => line.trim() !== '')
          .map(line => line.substring(3).trim()); // naive parse
      }

      await this._scanForSecrets(filesToScan);

      await this.verifier.verify(files);

      // SAFE EXECUTION: Prevent shell injection by avoiding 'git add ${files} and git commit -m "${message}"'
      // Use execFileAsync via runSafe

      // 1. Git Add
      // If files contains '.', we can use standard git add .
      // If specific files, pass them as arguments
      if (files.includes('.')) {
        await this.runSafe('git', ['add', '.']);
      } else {
        await this.runSafe('git', ['add', ...files]);
      }

      // 2. Git Commit
      // Pass message as a separate argument to avoid shell interpretation
      await this.runSafe('git', ['commit', '-m', message]);

      // 3. Git Push (origin master is hardcoded safe string, but consistent to use runSafe or run)
      await this.runSafe('git', ['push', 'origin', 'master']);

      return { success: true, message: 'Pushed to origin/master' };

    } catch (error) {
      console.error('[GitOps] Validation or Git Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async rollback() {
    try {
      console.log('[GitOps] Rolling back last commit...');
      // Ensure clean state
      await this.run('git reset --hard HEAD');

      // Revert the last commit. This creates a new commit.
      await this.run('git revert --no-edit HEAD');

      // Push the new revert commit
      await this.run('git push origin master');

      return { success: true, message: 'Rolled back last change successfully.' };
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

module.exports = { GitOps };
