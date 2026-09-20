import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAllTools} from '../src/tools/index.js';
import {CANARY_PROFILE,CANARY_LIST_ID} from '../src/profiles/canary-policy.js';
import AnyListClient from '../src/anylist-client.js';
import {validateClientRedirectUri} from '../src/http/auth/policy.js';
test('dedicated canary registers only fixed-list read actions and never exposes stable mutation/experimental tools',async()=>{
 const c=new AnyListClient();let reads=0;const lists=[{identifier:CANARY_LIST_ID,name:'Fixture',items:[{identifier:'one',name:'Synthetic',quantity:1,checked:true,details:'note'}],stores:[],categoryGroups:[]},{identifier:'unrelated',name:'Hidden',items:[]}];
 c.client={lists,getLists:async fresh=>{assert.equal(fresh,true);reads++;return lists;}};
 const handlers={};registerAllTools({registerTool(n,config,h){handlers[n]={config,h};}},()=>c,{profile:CANARY_PROFILE});
 assert.deepEqual(Object.keys(handlers),['shopping']);const {h,config}=handlers.shopping;assert.deepEqual(config.inputSchema.action.options,['list_lists','list_items']);
 const result=(await h({action:'list_items',list_id:CANARY_LIST_ID,response_format:'structured',include_checked:true,include_notes:true})).structuredContent;
 assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.items.length,1);assert.equal(result.items[0].checked,true);assert.equal(result.items[0].note,'note');assert.equal(result.provider.mutationsEnabled,false);assert.ok(result.freshReadAt);
 const discovery=(await h({action:'list_lists',list_id:CANARY_LIST_ID})).structuredContent;assert.equal(discovery.lists.length,1);assert.equal(discovery.lists[0].identifier,CANARY_LIST_ID);assert.ok(!JSON.stringify(discovery).includes('Hidden'));
 const count=reads;
 for(const input of [{action:'list_items'},{action:'list_items',list_id:'unrelated'},{action:'list_items',list_id:CANARY_LIST_ID,include_checked:false},{action:'delete_item',list_id:CANARY_LIST_ID,id:'one'},{action:'add_item',list_id:CANARY_LIST_ID,name:'New'}]){
  const response=await h(input);assert.equal(response.isError,true);assert.equal(response.structuredContent.error.code,'INVALID_INPUT');
 }
 assert.equal(reads,count);assert.equal(lists[0].items.length,1);
});
test('dedicated canary cannot bind a browser callback and become a broader OAuth profile',()=>{
 assert.throws(()=>validateClientRedirectUri({profile:CANARY_PROFILE,redirect_uri:null},'https://claude.ai/api/mcp/auth_callback'),e=>e.code==='unauthorized_client'&&e.status===403);
});
