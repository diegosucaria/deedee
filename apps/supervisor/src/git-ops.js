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

  async configure(name, email) {
    await this.run(`git config user.name "${name}"`);
    await this.run(`git config user.email "${email}"`);
  }

  async commitAndPush(message, files = ['.']) {
    try {
      // 0. Pre-Flight Checks
      await this.verifier.verify(files);

      // 1. Add files
      const fileList = files.join(' ');
      await this.run(`git add ${fileList}`);

      // 2. Commit
      await this.run(`git commit -m "${message}"`);

      // 3. Push
      await this.run('git push origin master'); // Assuming master branch as confirmed
      
      return { success: true, message: 'Pushed to origin/master' };

    } catch (error) {
      console.error('[GitOps] Validation or Git Error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = { GitOps };
