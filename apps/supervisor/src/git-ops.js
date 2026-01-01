const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class GitOps {
  constructor(workDir = '/app/source') {
    this.workDir = workDir;
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
    // 1. Add files
    const fileList = files.join(' ');
    await this.run(`git add ${fileList}`);

    // 2. Commit
    await this.run(`git commit -m "${message}"`);

    // 3. Push
    // Note: We assume the remote is already configured with the PAT token
    // or via SSH in the container setup.
    await this.run('git push origin main');
    
    return { success: true, message: 'Pushed to origin/main' };
  }
}

module.exports = { GitOps };
