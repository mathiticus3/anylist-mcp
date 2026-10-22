import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = mkdtempSync(path.join(os.tmpdir(), 'synthetic-write-authority-'));
process.env.DATA_DIR = directory;
const { getDb, saveOAuthTokens } = await import('../src/http/db.js');
const { assertCurrentWriteRequest } = await import('../src/http/auth/write-authority.js');
const db = getDb();
test.after(() => { db.close(); rmSync(directory, {recursive:true, force:true}); });
for (const mutation of ['client_delete','client_rebind','profile_change','source_change','callback_change','secret_removed','user_delete','token_delete','token_expire','token_rebind']) {
  test(`current write request rejects ${mutation} after initial admission`, () => {
    const expected = {clientId:randomUUID(),userId:randomUUID(),profile:'estate_hub_shopping_writer',actorSource:'estate-household-shopping-writer'};
    db.prepare('INSERT INTO users(id,email) VALUES (?,?)').run(expected.userId,expected.userId+'@example.invalid');
    db.prepare('INSERT INTO oauth_clients(client_id,user_id,client_secret_hash,profile,source) VALUES (?,?,?,?,?)')
      .run(expected.clientId,expected.userId,'synthetic-hash',expected.profile,expected.actorSource);
    const token = randomUUID();
    saveOAuthTokens({accessToken:token,refreshToken:randomUUID(),clientId:expected.clientId,userId:expected.userId,scope:'mcp'});
    const extra = {requestInfo:{headers:{authorization:'Bearer '+token}}};
    assert.doesNotThrow(() => assertCurrentWriteRequest(extra,expected));
    if (mutation==='client_delete') db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(expected.clientId);
    else if (mutation==='user_delete') { db.pragma('foreign_keys=OFF'); db.prepare('DELETE FROM users WHERE id=?').run(expected.userId); db.pragma('foreign_keys=ON'); }
    else if (mutation==='token_delete') db.prepare('DELETE FROM oauth_tokens WHERE access_token=?').run(token);
    else if (mutation==='token_expire') db.prepare('UPDATE oauth_tokens SET expires_at=0 WHERE access_token=?').run(token);
    else if (mutation==='token_rebind') db.prepare('UPDATE oauth_tokens SET client_id=? WHERE access_token=?').run(randomUUID(),token);
    else {
      const changes = {client_rebind:['user_id',null],profile_change:['profile','full'],source_change:['source','oauth'],callback_change:['redirect_uri','https://example.invalid/callback'],secret_removed:['client_secret_hash',null]};
      const [field,value] = changes[mutation]; db.prepare(`UPDATE oauth_clients SET ${field}=? WHERE client_id=?`).run(value,expected.clientId);
    }
    assert.throws(() => assertCurrentWriteRequest(extra,expected), error => error.code==='CURRENT_AUTHORITY_REVOKED');
  });
}
test('request authority cannot come from tool arguments or a previous initialize token',()=>{
  assert.throws(()=>assertCurrentWriteRequest({authorization:'Bearer synthetic'},{}), error=>error.code==='CURRENT_AUTHORITY_REVOKED');
});
