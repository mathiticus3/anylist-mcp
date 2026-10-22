import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import AnyList from '../src/anylist-legacy-client.cjs';
import AnyListClient from '../src/anylist-client.js';
test('dedicated writer transport never retries data POSTs, including the library authentication replay hook', async t => {
  let status = 401, posts = 0, refreshes = 0;
  const server = http.createServer((request, response) => { posts++; request.resume(); response.writeHead(status); response.end('synthetic upstream failure'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalLogin = AnyList.prototype.login, originalLists = AnyList.prototype.getLists;
  const originalRefresh = AnyList.prototype._refreshTokens, originalLog = console.error, logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  AnyList.prototype.login = async function (websocket) {
    assert.equal(websocket, false); this.uid = 'synthetic-upstream'; this.accessToken = 'synthetic-access'; this.clientId = 'synthetic-client';
    this.client = this.client.extend({ prefixUrl: `http://127.0.0.1:${server.address().port}/` });
  };
  AnyList.prototype.getLists = async () => [];
  AnyList.prototype._refreshTokens = async () => { refreshes++; };
  try {
    const client = new AnyListClient({ username: 'private-account-sentinel', password: 'synthetic', oneShotWrites: true });
    const raw = await client.ensureAuthenticated();
    for (const code of [401, 500, 502]) { status = code; await assert.rejects(raw.client.post('data/synthetic-test/update', { body: 'synthetic' })); }
    assert.equal(posts, 3); assert.equal(refreshes, 0);
    assert.ok(!logs.join(' ').includes('private-account-sentinel'));
    assert.ok(!logs.join(' ').includes('synthetic-access'));
  } finally {
    AnyList.prototype.login = originalLogin; AnyList.prototype.getLists = originalLists;
    AnyList.prototype._refreshTokens = originalRefresh; console.error = originalLog;
  }
});
