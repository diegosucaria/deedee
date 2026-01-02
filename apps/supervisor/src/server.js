const express = require('express');
const { GitOps } = require('./git-ops');

const app = express();
const port = process.env.PORT || 4000;
const git = new GitOps();

app.use(express.json());

const gitName = process.env.GIT_USER_NAME || 'Deedee Supervisor';
const gitEmail = process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot';
const gitRemote = process.env.GIT_REMOTE_URL;

git.configure(gitName, gitEmail, gitRemote).catch(console.error);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'supervisor' });
});

app.post('/cmd/commit', async (req, res) => {
  try {
    const { message, files } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Commit message is required' });
    }
    
    console.log(`[Supervisor] Committing: "${message}"`);
    const result = await git.commitAndPush(message, files);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Supervisor listening at http://localhost:${port}`);
  });
}

module.exports = { app };