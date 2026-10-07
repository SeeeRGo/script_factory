import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeJobResult } from '../src/job-result.js';
test('artifact response preserves filename and API link without leaking the node path', () => {
  assert.deepEqual(serializeJobResult({context:{Rezult_1:{ok:true},private_key:'secret'},artifacts:[
    {filename:'Отчёт.xml',api_url:'/api/v2/jobs/id/artifacts/file',local_path:'C:/private/file',artifact_id:'file'}
  ]}), {artifacts:[{filename:'Отчёт.xml',api_url:'/api/v2/jobs/id/artifacts/file'}],Rezult_1:{ok:true}});
});
test('legacy URL-only artifacts have an explicit missing filename instead of an invented one', () => {
  assert.deepEqual(serializeJobResult({artifacts:['/api/v2/jobs/id/artifacts/file',null,{}]}),
    {artifacts:[{filename:null,api_url:'/api/v2/jobs/id/artifacts/file'}]});
});
