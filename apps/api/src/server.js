require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');
const chatRouter = require('./chat');
const briefingRouter = require('./briefing');
const cityImageRouter = require('./city-image');

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// Health Check (Public)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'api' });
});

// Protected V1 Routes
app.use('/v1', authMiddleware);
app.use('/v1/chat', chatRouter);
app.use('/v1/briefing', briefingRouter);
app.use('/v1/city-image', cityImageRouter);

if (require.main === module) {
    app.listen(port, () => {
        console.log(`API Service listening on port ${port}`);
    });
}

module.exports = { app };
