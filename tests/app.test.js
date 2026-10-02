'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
async function withApp(getDb, testFn) {
  const server = createApp({ getDb }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await testFn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('liveness stays up while DB readiness fails', async () => {
  await withApp(() => undefined, async base => {
    assert.equal((await fetch(base + '/health/live')).status, 200);
    assert.equal((await fetch(base + '/health/ready')).status, 503);
    assert.equal((await fetch(base + '/api/movies')).status, 503);
  });
});
test('serves UI but never source files or fake health paths', async () => {
  await withApp(() => ({}), async base => {
    assert.equal((await fetch(base + '/')).status, 200);
    for (const path of ['/server.js', '/package.json', '/health/missing', '/api/missing']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
  });
});
test('validates writes and preserves MongoDB field names', async () => {
  let inserted;
  const db = { command: async () => ({ok: 1}), collection: () => ({
    insertOne: async movie => { inserted = movie; return { insertedId: 'test-id' }; }
  }) };
  await withApp(() => db, async base => {
    const post = body => fetch(base + '/api/movies', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal((await fetch(base + '/health/ready')).status, 200);
    for (const collection of ['', null, true, -1, '12abc']) {
      assert.equal((await post({movieName:'Film', hero:'Actor', status:'Hit', collection})).status, 400);
    }
    assert.equal((await post({movieName:' Film ', hero:'Actor', status:'Hit', collection:'12.5'})).status, 201);
    assert.equal(inserted.movie_name, 'Film');
    assert.equal(inserted.collection, 12.5);
  });
});
test('search escapes regex characters and bounds result count', async () => {
  let filter, limit;
  const cursor = {sort() {return this;}, limit(n) {limit=n; return this;},
    async toArray() {return [];} };
  const db = {collection: () => ({find(f) {filter=f; return cursor;}})};
  await withApp(() => db, async base => {
    assert.equal((await fetch(base + '/api/movies?query=%5B.*')).status, 200);
    assert.equal(filter.$or[0].movie_name.source, '\\[\\.\\*');
    assert.equal(limit, 100);
  });
});
test('database errors produce 503', async () => {
  const db = {command: async () => {throw new Error('offline');},
    collection: () => ({find() {throw new Error('offline');}})};
  await withApp(() => db, async base => {
    assert.equal((await fetch(base + '/health/ready')).status, 503);
    assert.equal((await fetch(base + '/api/movies')).status, 503);
  });
});
