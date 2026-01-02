
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const validToken = process.env.DEEDEE_API_TOKEN;

    if (!validToken) {
        console.error('[API] Server configuration error: DEEDEE_API_TOKEN is not set.');
        return res.status(500).json({ error: 'Server authentication configuration error' });
    }

    if (token !== validToken) {
        return res.status(403).json({ error: 'Invalid API Token' });
    }

    next();
};

module.exports = { authMiddleware };
