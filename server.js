'use strict';
const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

function createApp({ getDb, isStopping = () => false }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    const requestPath = req.path;
    res.on('finish', () => console.log(JSON.stringify({
      time: new Date().toISOString(), method: req.method,
      path: requestPath, status: res.statusCode
    })));
    next();
  });
  app.get('/health/live', (req, res) => res.json({ status: 'alive' }));
  app.get('/health/ready', async (req, res) => {
    try {
      if (isStopping() || !getDb()) throw new Error('Not ready');
      await getDb().command({ ping: 1 });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not ready' });
    }
  });
  app.use('/api', (req, res, next) => {
    if (isStopping() || !getDb()) return res.status(503).json({ message: 'Not ready' });
    next();
  });
  app.post('/api/movies', async (req, res) => {
    const { movieName, hero, collection, status } = req.body || {};
    const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
    const amount = typeof collection === 'number' ||
      (typeof collection === 'string' && collection.trim() !== '') ? Number(collection) : NaN;
    if (![movieName, hero, status].every(validText) || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ message: 'Provide movieName, hero, status and a nonnegative numeric collection' });
    }
    try {
      const result = await getDb().collection('movies').insertOne({
        movie_name: movieName.trim(), hero: hero.trim(), collection: amount,
        status: status.trim(), created_at: new Date()
      });
      res.status(201).json({ message: 'Movie saved', id: result.insertedId });
    } catch {
      console.error('Movie insert failed');
      res.status(503).json({ message: 'Database temporarily unavailable' });
    }
  });
  app.get('/api/movies', async (req, res) => {
    const query = req.query.query;
    if (query !== undefined && (typeof query !== 'string' || query.length > 200)) {
      return res.status(400).json({ message: 'Invalid search query' });
    }
    const filter = {};
    if (query) {
      // Search user input literally; do not execute user-provided regex syntax.
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ movie_name: regex }, { hero: regex }];
    }
    try {
      const movies = await getDb().collection('movies').find(filter)
        .sort({ created_at: -1 }).limit(100).toArray();
      res.json(movies);
    } catch {
      console.error('Movie query failed');
      res.status(503).json({ message: 'Database temporarily unavailable' });
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ message: 'Unknown API route' }));
  app.use(express.static(path.join(__dirname, 'public')));
  // No catch-all 200 response: missing assets and health routes must return 404.
  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ message: status === 500 ? 'Internal Server Error' : 'Invalid request body' });
  });
  return app;
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const uri = process.env.MONGO_URL;
  if (!uri) throw new Error('MONGO_URL is required');
  const username = process.env.MONGO_USERNAME;
  const password = process.env.MONGO_PASSWORD;
  if (Boolean(username) !== Boolean(password)) throw new Error('Supply both database credentials');
  const options = { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000 };
  if (username) options.auth = { username, password };
  const client = new MongoClient(uri, options);
  let db, server, stopping = false;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await client.connect();
      db = client.db(process.env.DB_NAME || 'demo_boxoffice');
      await db.command({ ping: 1 });
      break;
    } catch {
      console.error(`Database startup attempt ${attempt}/12 failed`);
      if (attempt === 12) { await client.close(); throw new Error('Database startup failed'); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  const app = createApp({ getDb: () => db, isStopping: () => stopping });
  server = app.listen(port, '0.0.0.0', () => console.log(`Listening on port ${port}`));
  server.on('error', async () => { console.error('HTTP listener failed'); await client.close(); process.exit(1); });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    server.close(async () => {
      try { await client.close(); process.exit(0); }
      catch { process.exit(1); }
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
if (require.main === module) start().catch(() => {
  console.error('Startup failed; verify database configuration and connectivity');
  process.exit(1);
});
module.exports = { createApp };
