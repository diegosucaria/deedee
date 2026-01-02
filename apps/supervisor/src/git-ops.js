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
    try {
      await this.run('git rev-parse --is-inside-work-tree');
    } catch (error) {
      await this.run('git init');
      await this.run('git checkout -B master');
    }

    await this.run(`git config user.name "${name}"`);
    await this.run(`git config user.email "${email}"`);

    if (remoteUrl) {
      try {
        await this.run(`git remote set-url origin ${remoteUrl}`);
      } catch (error) {
        await this.run(`git remote add origin ${remoteUrl}`);
      }
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
}

module.exports = { GitOps };
