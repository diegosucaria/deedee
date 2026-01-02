const { exec } = require('child_process');
const util = require('util');
const { Verifier } = require('./verifier');
const execAsync = util.promisify(exec);

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

  async configure(name, email, remoteUrl) {
    // Initialize (idempotent) to ensure repo exists without causing 'not a git repository' errors
    await this.run('git init');
    await this.run('git checkout -B master');

    await this.run(`git config user.name "${name}"`);
    await this.run(`git config user.email "${email}"`);

    if (remoteUrl) {
      console.log(`[GitOps] Configuring remote: ${remoteUrl}`);
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

  async commitAndPush(message, files = ['.']) {
    try {
      await this.verifier.verify(files);

      const fileList = files.join(' ');
      await this.run(`git add ${fileList}`);

      await this.run(`git commit -m "${message}"`);

      await this.run('git push origin master');

      return { success: true, message: 'Pushed to origin/master' };

    } catch (error) {
      console.error('[GitOps] Validation or Git Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async rollback() {
    try {
      console.log('[GitOps] Rolling back last commit...');
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
}

module.exports = { GitOps };
