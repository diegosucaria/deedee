const express = require('express');
const { GitOps } = require('./git-ops');
const { Verifier } = require('./verifier');
const { Monitor } = require('./monitor');
const { Writable } = require('stream');
const Docker = require('dockerode');

class PrefixWriter extends Writable {
  constructor(prefix, destination) {
    super();
    this.prefix = prefix;
    this.destination = destination;
    this.buffer = '';
  }

  _write(chunk, encoding, callback) {
    // Determine encoding just in case, though usually UTF8 from Docker
    const text = chunk.toString();
    const parts = (this.buffer + text).split('\n');
    this.buffer = parts.pop(); // Keep last incomplete line

    parts.forEach(line => {
      // Only write if line has content or we want to preserve empty lines (usually better to skip empty to save noise)
      if (line.length > 0) {
        this.destination.write(`[${this.prefix}] ${line}\n`);
      }
    });
    callback();
  }
}

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

git.configure(gitName, gitEmail, gitRemote).then(() => {
  console.log('[Supervisor] Git configured. Starting monitor...');
  monitor.start();
}).catch(console.error);

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
  const tail = req.query.tail; // 10m, 1h, or number like 100
  const since = req.query.since;
  const until = req.query.until;

  const docker = new Docker();

  // Helper to parse 'since' (duration string -> timestamp)
  const parseSince = (val) => {
    if (!val) return undefined;
    const match = val.match(/^(\d+)(m|h|d)$/);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2];
      let seconds = 0;
      if (unit === 'm') seconds = num * 60;
      if (unit === 'h') seconds = num * 3600;
      if (unit === 'd') seconds = num * 86400;
      return Math.floor((Date.now() / 1000) - seconds);
    }
    return val;
  };

  const calculatedSince = parseSince(since);

  try {
    const allContainers = await docker.listContainers({ all: true });

    // --- MULTIPLEX 'ALL' ---
    if (name === 'all') {
      const TARGETS = ['agent', 'api', 'web', 'supervisor', 'interfaces'];
      const streams = [];

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setTimeout(0);

      console.log(`[Supervisor] Streaming ALL logs (since: ${since})`);

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        res.write('[SYSTEM] HEARTBEAT\n');
      }, 15000);

      const streamPromises = TARGETS.map(async (targetName) => {
        // Find container
        const targetContainer = allContainers.find(c => c.Names.some(n => n.includes(targetName)));
        if (!targetContainer) return null;

        const container = docker.getContainer(targetContainer.Id);
        const logOptions = {
          follow: true,
          stdout: true,
          stderr: true,
          tail: (since || until) ? undefined : (tail || 50), // Lower tail for 'all' to avoid flood
          since: calculatedSince,
          until: until
        };

        try {
          // Inspect to check TTY
          const info = await container.inspect();
          const isTty = info.Config && info.Config.Tty;

          const stream = await container.logs(logOptions);

          const writer = new PrefixWriter(targetName, res);

          if (isTty) {
            // TTY streams are just raw text
            stream.pipe(writer);
          } else {
            // Non-TTY streams have an 8-byte header per frame
            container.modem.demuxStream(stream, writer, writer);
          }

          return stream;
        } catch (e) {
          console.error(`Error streaming ${targetName}:`, e.message);
          return null;
        }
      });

      const results = await Promise.all(streamPromises);
      streams.push(...results.filter(s => s !== null));

      req.on('close', () => {
        console.log('[Supervisor] Client closed connection for ALL logs');
        clearInterval(heartbeat);
        streams.forEach(s => s.destroy());
      });

      return;
    }

    // --- SINGLE CONTAINER ---
    const target = allContainers.find(c => c.Names.some(n => n.includes(name)));

    if (!target) {
      return res.status(404).json({ error: `Container '${name}' not found` });
    }

    const container = docker.getContainer(target.Id);

    const logOptions = {
      follow: true,
      stdout: true,
      stderr: true,
      tail: (since || until) ? undefined : (tail || 200),
      since: calculatedSince,
      until: until
    };

    console.log(`[Supervisor] Streaming logs for ${name} (since: ${since})`);

    const logStream = await container.logs(logOptions);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const info = await container.inspect();
    const isTty = info.Config && info.Config.Tty;

    if (isTty) {
      logStream.pipe(res);
    } else {
      container.modem.demuxStream(logStream, res, res);
    }

    req.on('close', () => {
      try { logStream.destroy(); } catch (e) { }
    });

  } catch (err) {
    console.error(`[Supervisor] Log Error (${name}):`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Supervisor listening at http://localhost:${port}`);
  });
}

module.exports = { app };