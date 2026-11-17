import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../fleet/fleet-ui.js',import.meta.url),'utf8');
const handler=/^\$\('release-form'\)\.onsubmit=(.*);$/m.exec(source)[1];
async function submit(value){
 const calls=[];let message='',completion;
 const context={snapshot:{releases:{}},FormData:class{get(name){return name==='manifest'?{text:async()=>JSON.stringify(value)}:'ZIP';}},api:async(...args)=>{calls.push(args);},say:value=>{message=value;},action:run=>{completion=Promise.resolve().then(run).catch(error=>{message=error.message;});}};
 const run=vm.runInNewContext('('+handler+')',context);run({preventDefault(){},target:{}});await completion;return {calls,message};
}
test('release form rejects a node inventory with a useful message before sending requests',async()=>{
 const result=await submit([{id:'un-nefedova',un_id:'un-nefedova-test'}]);assert.equal(result.calls.length,0);assert.match(result.message,/nodes\.json/);assert.match(result.message,/manifest/);
});
test('release form uploads a manifest and matching ZIP through their separate API endpoints',async()=>{
 const envelope={manifest:{id:'release-test'},signature:'test-signature'};const result=await submit(envelope);
 assert.equal(result.calls.length,2);assert.equal(result.calls[0][0],'/api/releases');assert.equal(result.calls[1][0],'/api/releases/release-test/package');assert.match(result.message,/загружен/);
});
