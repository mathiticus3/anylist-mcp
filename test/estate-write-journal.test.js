import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initializeJournal,openJournal} from '../src/profiles/estate-write-journal.js';
const policyDigest='a'.repeat(64),clientId=randomUUID();
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-write-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'journal.sqlite3'),journalId=randomUUID();initializeJournal(file,journalId);const open=()=>openJournal(file,journalId);return {file,journalId,open};}
const input=()=>({clientId,changeId:randomUUID(),policyDigest,commandHash:'b'.repeat(64),domain:'shopping:fixture',command:{operation:'shopping.add',fields:{name:'Fixture',quantity:1}}});
test('journal requires explicit initialization and exact private identity',t=>{const f=fixture(t);assert.throws(()=>openJournal(f.file,randomUUID()));assert.throws(()=>openJournal(f.file+'-absent',f.journalId));chmodSync(f.file,0o644);assert.throws(()=>f.open());});
test('one reservation across independent workers, conflicting reuse denied',t=>{const f=fixture(t),a=f.open(),b=f.open();t.after(()=>{a.close();b.close();});const p=input();const first=a.reserve(p);assert.equal(first.state,'PREPARED');assert.deepEqual(b.reserve(p),first);assert.throws(()=>b.reserve({...p,commandHash:'c'.repeat(64)}));assert.throws(()=>b.reserve({...input(),domain:p.domain}),/DOMAIN_BUSY/);});
test('dispatch boundary survives close/reopen and cannot be claimed twice',t=>{const f=fixture(t),p=input();let a=f.open();a.reserve(p);a.begin(clientId,p.changeId,{recordId:'synthetic-source-id',before:{exists:false},after:{exists:true}});a.close();a=f.open();t.after(()=>a.close());assert.equal(a.get(clientId,p.changeId,policyDigest).state,'UNKNOWN');assert.throws(()=>a.begin(clientId,p.changeId,{}));assert.throws(()=>a.get(randomUUID(),p.changeId,policyDigest));assert.throws(()=>a.get(clientId,p.changeId,'c'.repeat(64)));assert.equal(a.reserve(p).state,'UNKNOWN');});
test('acknowledgement is durable; only confirmed readback releases the domain fence',t=>{const f=fixture(t),p=input();let a=f.open();a.reserve(p);a.begin(clientId,p.changeId,{recordId:'id'});a.acknowledge(clientId,p.changeId);a.close();a=f.open();t.after(()=>a.close());assert.equal(a.get(clientId,p.changeId,policyDigest).state,'ACKNOWLEDGED');assert.throws(()=>a.reserve(input()),/DOMAIN_BUSY/);a.confirm(clientId,p.changeId,{postcondition_observed:true});assert.equal(a.get(clientId,p.changeId,policyDigest).state,'CONFIRMED');assert.equal(a.reserve(input()).state,'PREPARED');});
test('observing a postcondition does not manufacture an ACK or release UNKNOWN',t=>{const f=fixture(t),a=f.open();t.after(()=>a.close());const p=input();a.reserve(p);a.begin(clientId,p.changeId,{recordId:'id'});a.observe(clientId,p.changeId,{postcondition_observed:true});assert.equal(a.get(clientId,p.changeId,policyDigest).state,'UNKNOWN');assert.throws(()=>a.confirm(clientId,p.changeId,{}));assert.throws(()=>a.reserve(input()),/DOMAIN_BUSY/);});
test('pre-dispatch abandonment is durable and releases only a PREPARED fence',t=>{const f=fixture(t),a=f.open();t.after(()=>a.close());const p=input();a.reserve(p);a.refuse(clientId,p.changeId,'PRECONDITION_CHANGED');assert.equal(a.get(clientId,p.changeId,policyDigest).state,'NOT_DISPATCHED');assert.equal(a.reserve(p).state,'NOT_DISPATCHED');assert.equal(a.reserve(input()).state,'PREPARED');});

test('offline administrator can release a reviewed UNKNOWN fence without rewriting its outcome or replay key', t => {
  const f = fixture(t), a = f.open(); t.after(() => a.close()); const command = input();
  a.reserve(command); a.begin(clientId, command.changeId, { record_id: 'id' });
  assert.throws(() => a.releaseAfterOfflineReview(clientId, command.changeId, {
    expectedCommandHash: 'c'.repeat(64), approvalReference: 'synthetic-owner-approval', reviewedOutcome: 'effect_observed' }));
  const resolved = a.releaseAfterOfflineReview(clientId, command.changeId, {
    expectedCommandHash: command.commandHash, approvalReference: 'synthetic-owner-approval', reviewedOutcome: 'uncertainty_accepted' });
  assert.equal(resolved.state, 'UNKNOWN'); assert.equal(resolved.administrative_resolution.reviewed_outcome, 'uncertainty_accepted');
  assert.equal(a.reserve(command).state, 'UNKNOWN'); assert.equal(a.reserve(input()).state, 'PREPARED');
});
