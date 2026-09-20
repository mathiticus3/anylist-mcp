import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import express from 'express';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv/dist/2020.js';
import {mountActions,authenticate} from '../src/actions/router.js';
import {PROJECTION,projectionFor} from '../src/actions/projection.js';
import {openapi} from '../src/actions/openapi.js';
import {CAPABILITIES} from '../src/stable/capabilities.js';
import AnyListClient from '../src/anylist-client.js';
import AnyList from '../src/anylist-legacy-client.cjs';
const token='a'.repeat(43);
const record={enabled:true,userId:'fixture-owner',sha256:createHash('sha256').update(token).digest('hex')};
test('OpenAPI 3.1 validates and projects every stable capability with unique bounded operations',async()=>{
 const doc=openapi();await SwaggerParser.validate(structuredClone(doc));
 assert.equal(doc.openapi,'3.1.0');assert.equal(PROJECTION.length,30);
 const coverage=new Set(PROJECTION.flatMap(p=>p.targets));
 for(const c of CAPABILITIES){const key=c.tool+'/'+c.action;assert.ok(coverage.has(key),key);const p=projectionFor(c.tool,c.action,{});assert.ok(p.entry.targets.includes(key));}
 for(const entry of PROJECTION){assert.ok(doc.paths['/actions/'+entry.operationId].post.description.length<=300);assert.equal(entry.schema.safeParse({rpc:'anything'}).success,false);}
 assert.equal(authenticate('Bearer '+token,record),true);assert.equal(authenticate('Bearer '+token,{...record,enabled:false}),false);assert.equal(authenticate('Bearer bad',record),false);
});
test('actual HTTP Actions use registered MCP handlers, fail closed, preserve exact IDs and share typed schemas',async t=>{
 const raw=new AnyList({email:'fixture@example.invalid',password:'unused',credentialsFile:null});raw.uid='user';
 const c=new AnyListClient();c.client=raw;const items=[];let reads=0,posts=0,fail=false;
 raw.client={post:async()=>{posts++;if(fail)throw Error('SECRET upstream diagnostic');return {};}};
 const list={identifier:'fixture-list',name:'Test',items,stores:[],categoryGroups:[],addItem:async i=>{i.listId='fixture-list';items.push(i);},removeItem:async i=>items.splice(items.indexOf(i),1)};
 raw.lists=[list];raw.getLists=async()=>{reads++;return raw.lists;};
 let key=record;const app=express();mountActions(app,{getClientForUser:async id=>{assert.equal(id,'fixture-owner');return c;},credential:()=>key,limiter:false});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const doc=await SwaggerParser.dereference(structuredClone(openapi()));const ajv=new Ajv({strict:false,validateFormats:false});
 async function call(id,input={},expected=200){const res=await fetch(base+'/actions/'+id,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});const body=await res.json();assert.equal(res.status,expected,JSON.stringify(body));const schema=doc.paths['/actions/'+id].post.responses[expected].content['application/json'].schema;const validate=ajv.compile(schema);assert.ok(validate(body),JSON.stringify(validate.errors));return body;}
 assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/readyz')).status,401);assert.equal((await fetch(base+'/readyz',{headers:{Authorization:'Bearer '+token}})).status,200);
 assert.equal((await fetch(base+'/actions/listShoppingLists',{method:'POST'})).status,401);
 assert.equal((await fetch(base+'/openapi.json')).status,200);assert.equal((await fetch(base+'/privacy')).status,200);
 await call('listShoppingLists');await call('getServiceStatus',{mode:'capabilities'});
 const added=await call('addShoppingItem',{list_id:list.identifier,name:'Milk',notes:'test'});assert.ok(added.item.identifier);assert.equal(items.length,1);
 await call('addShoppingItem',{list_id:list.identifier,name:'Milk',quantity:2});assert.equal(items.length,1);
 await call('addShoppingItems',{list_id:list.identifier,items:[{name:'Bread'},{name:'Eggs'}]});assert.equal(items.length,3);
 const id=added.item.identifier;await call('updateShoppingItem',{list_id:list.identifier,id,quantity:3,notes:'changed'});
 await call('checkShoppingItem',{list_id:list.identifier,id});let snap=await call('getShoppingList',{list_id:list.identifier,include_checked:true,include_notes:true});assert.equal(snap.items.find(i=>i.identifier===id).checked,true);
 await call('uncheckShoppingItem',{list_id:list.identifier,id});
 await call('deleteShoppingItem',{list_id:list.identifier,id});snap=await call('getShoppingList',{list_id:list.identifier,include_checked:true});assert.ok(!snap.items.some(i=>i.identifier===id));assert.equal(snap.items.length,2);
 await call('deleteShoppingItem',{list_id:list.identifier,id},404);await call('addShoppingItems',{items:[]},400);await call('addShoppingItem',{name:'bad',rpc:'escape'},400);
 raw.lists.push({...list,identifier:'other-list'});await call('getShoppingList',{list_name:'Test'},409);raw.lists.pop();
 items.push(raw.createItem({name:'Bread'}));const ambiguous=await call('deleteShoppingItem',{list_id:list.identifier,name:'Bread'},409);assert.equal(ambiguous.error.candidates.length,2);
 fail=true;const failed=await call('checkShoppingItem',{list_id:list.identifier,id:items[0].identifier},502);assert.ok(!JSON.stringify(failed).includes('SECRET'));
 const malformed=await fetch(base+'/actions/addShoppingItem',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);
 const oversized=await fetch(base+'/actions/addShoppingItem',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'x'.repeat(100000)})});assert.equal(oversized.status,413);
 key={...record,enabled:false};assert.equal((await fetch(base+'/readyz',{headers:{Authorization:'Bearer '+token}})).status,401);assert.ok(reads>10);assert.ok(posts>0);
});
