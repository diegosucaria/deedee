const express = require('express');
const { GitOps } = require('./git-ops');
const { Verifier } = require('./verifier');
const { Monitor } = require('./monitor');
const { HealthMonitor } = require('./health-monitor');
const { Writable } = require('stream');
const { BalenaLogs, balenaApiAvailable } = require('./balena-logs');
const crypto = require('crypto');

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
const healthMonitor = new HealthMonitor();
healthMonitor.start();

app.use(express.json());

// Constant-time compare of two secrets. False when either is missing or
// the lengths differ (timingSafeEqual needs equal-length buffers).
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Security: Simple Token Auth. Protect all routes except /health.
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const validToken = process.env.SUPERVISOR_TOKEN;
  if (!validToken) {
    // Fail closed: with no token configured nothing but /health answers.
    console.error('[Supervisor] SUPERVISOR_TOKEN is not set; refusing request.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.headers['x-supervisor-token'];
  if (!tokenMatches(token, validToken)) {
    console.warn(`[Supervisor] Unauthorized access attempt from ${req.ip}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
});

const gitName = process.env.GIT_USER_NAME || 'Deedee Supervisor';
const gitEmail = process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot';
const gitRemote = process.env.GIT_REMOTE_URL;
// The PAT stays out of the stored remote URL. `.git/config` lives on the
// /app/source volume, which the agent reads and writes, so a token there is
// a token the agent can send anywhere. GitOps passes it per command instead.
const githubPat = process.env.GITHUB_PAT;
console.log(`[Supervisor] Configured remote: ${gitRemote || '(none)'}${githubPat ? ' with a token' : ''}`);

git.configure(gitName, gitEmail, gitRemote, githubPat).then(() => {
  console.log('[Supervisor] Git configured. Starting monitor...');
  return monitor.start();
}).catch(console.error);

app.get('/health', (req, res) => {
  res.json({
    service: 'supervisor',
    status: 'ok',
    monitor: healthMonitor.getStatus()
  });
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

// Opens a pull request that reverts the newest commit on master. Nothing is
// pushed to master; the owner merges the revert.
app.post('/cmd/rollback', async (req, res) => {
  try {
    console.log('[Supervisor] Received Rollback Request');
    const result = await git.rollback();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Whether git tracks a path of the work tree, from the supervisor's own index.
// The agent's file tools read tracked source without the line redaction.
app.get('/cmd/tracked', async (req, res) => {
  try {
    const file = typeof req.query.path === 'string' ? req.query.path : '';
    res.json({ tracked: await git.isTracked(file) });
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


// Services whose logs the UI may read, by exact name.
const LOG_SERVICES = ['agent', 'api', 'web', 'supervisor', 'interfaces'];

app.get('/logs/:container', async (req, res) => {
  const name = req.params.container;
  const tail = req.query.tail; // 10m, 1h, or number like 100
  const since = req.query.since;
  const until = req.query.until;

  // On the device: the balena supervisor API (no engine socket mounted).
  if (balenaApiAvailable()) {
    if (name !== 'all' && !LOG_SERVICES.includes(name)) {
      return res.status(404).json({ error: `Container '${name}' not found` });
    }
    let handle;
    try {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setTimeout(0);
      handle = await new BalenaLogs().stream({
        services: name === 'all' ? LOG_SERVICES : [name],
        tail: tail || (name === 'all' ? 50 : 200),
        since,
        until,
        out: res
      });
      req.on('close', () => handle.stop());
    } catch (err) {
      console.error(`[Supervisor] Log Error (${name}):`, err.message);
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
      else if (!res.writableEnded) res.end(`[SYSTEM] ${err.message}\n`);
    }
    return;
  }

  // Local development: an engine socket, when one is mounted by an override.
  let Docker;
  try {
    Docker = require('dockerode');
  } catch {
    return res.status(503).json({ error: 'No log source: neither the balena supervisor API nor dockerode is available.' });
  }
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