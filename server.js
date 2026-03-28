const express  = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const { Pool }  = require('pg');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. In Railway: open your app service → Variables → add DATABASE_URL = ${{Postgres.DATABASE_URL}}');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init ─────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key        TEXT PRIMARY KEY,
            value      JSONB        NOT NULL,
            updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `);
    console.log('DB ready');
}

// ── REST: bulk fetch (startup load) ─────────────────────────────────────────
app.get('/data', async (req, res) => {
    try {
        const result = await pool.query('SELECT key, value FROM kv_store');
        const out = {};
        result.rows.forEach(r => { out[r.key] = r.value; });
        res.json(out);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── REST: save one key ───────────────────────────────────────────────────────
app.post('/data/:key', async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    try {
        await pool.query(
            `INSERT INTO kv_store (key, value, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE
               SET value = EXCLUDED.value,
                   updated_at = NOW()`,
            [key, JSON.stringify(value)]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── Socket.io ────────────────────────────────────────────────────────────────
// Clients emit  { socketId, msg }  and the server fans out to everyone else.
io.on('connection', socket => {
    socket.emit('connected', socket.id);

    socket.on('broadcast', ({ msg }) => {
        // broadcast to every client EXCEPT the sender
        socket.broadcast.emit('channel_msg', msg);
    });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
    .then(() => server.listen(PORT, () => console.log(`Kitchen POS listening on :${PORT}`)))
    .catch(err => { console.error('DB init failed', err); process.exit(1); });
