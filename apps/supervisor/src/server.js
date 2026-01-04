const express = require('express');
const { GitOps } = require('./git-ops');
const { Verifier } = require('./verifier');
const { Monitor } = require('./monitor');
const Docker = require('dockerode');

const app = express();
const port = process.env.PORT || 4000;
const git = new GitOps();
const verifier = new Verifier();
const monitor = new Monitor(git);

app.use(express.json());

const gitName = process.env.GIT_USER_NAME || 'Deedee Supervisor';
const gitEmail = process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot';
let gitRemote = process.env.GIT_REMOTE_URL;
const githubPat = process.env.GITHUB_PAT;

// Inject PAT into URL if available and URL is HTTPS
if (gitRemote && githubPat && gitRemote.startsWith('https://')) {
  // Insert PAT: https://PAT@github.com/...
  gitRemote = gitRemote.replace('https://', `https://${githubPat}@`);
  console.log(`[Supervisor] Configured authenticated remote: ${gitRemote.replace(githubPat, '***')}`);
} else {
  console.log(`[Supervisor] Configured remote: ${gitRemote}`);
}

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

app.post('/cmd/rollback', async (req, res) => {
  try {
    console.log('[Supervisor] Received Rollback Request');
    const result = await git.rollback();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/cmd/pull', async (req, res) => {
  try {
    console.log('[Supervisor] Received Pull Request');
    const result = await git.pull();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/logs/:container', async (req, res) => {
  const name = req.params.container;
  const tail = req.query.tail;
  const since = req.query.since; // timestamps or relative (e.g. 10m)
  const until = req.query.until;

  // Use standard Docker connection (Env vars or default socket)
  const docker = new Docker();

  try {
    const containers = await docker.listContainers({ all: true });
    // Fuzzy match: 'agent' matches 'deedee_agent_1'
    const target = containers.find(c => c.Names.some(n => n.includes(name)));

    if (!target) {
      return res.status(404).json({ error: `Container '${name}' not found` });
    }

    const container = docker.getContainer(target.Id);

    const logOptions = {
      follow: true,
      stdout: true,
      stderr: true,
      // If no time filter is set, default to tail 200. If time filter IS set, default tail to 'all' (undefined) to see full range.
      tail: (since || until) ? undefined : (tail || 200)
    };
    if (since) logOptions.since = since;
    if (until) logOptions.until = until;

    console.log(`[Supervisor] Streaming logs for ${name} (since: ${since}, tail: ${logOptions.tail})`);

    const logStream = await container.logs(logOptions);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx / Balena Proxy buffering disable

    // Inspect to check if TTY is enabled
    const info = await container.inspect();
    const isTty = info.Config && info.Config.Tty;

    console.log(`[Supervisor] Streaming logs for ${name} (tty: ${isTty})`);

    if (isTty) {
      // TTY enabled: raw stream is already text
      logStream.pipe(res);
    } else {
      // TTY disabled: multiplexed stream (binary headers)
      // Demux stdout and stderr to the response
      container.modem.demuxStream(logStream, res, res);
    }

    req.on('close', () => {
      try { logStream.destroy(); } catch (e) { }
    });

  } catch (err) {
    console.error(`[Supervisor] Log Error (${name}):`, err.message);
    // Only send error json if headers haven't sent (streaming might have started)
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end(`\n[Error] ${err.message}`);
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Supervisor listening at http://localhost:${port}`);
  });
}

module.exports = { app };