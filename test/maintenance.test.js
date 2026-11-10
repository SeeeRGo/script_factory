import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMaintenance} from '../src/maintenance.js';
import {createPowerManager,powerDefaults} from '../src/power-management.js';

test('maintenance closes admission synchronously, drains work, seals downloads and survives restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sf-maintenance-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let blockers=['JOBS_PENDING'];const m=await createMaintenance({dataDir:dir,getBlockers:()=>blockers});
 const entering=m.begin('fleet-one');assert.throws(()=>m.assertAdmission(),{code:'SERVICE_MAINTENANCE'});await entering;
 assert.equal(m.snapshot().ready_to_update,false);m.assertTransfer();
 await assert.rejects(m.seal('fleet-one'),{code:'MAINTENANCE_NOT_DRAINED'});
 blockers=['CALLBACK_PENDING'];await assert.rejects(m.seal('fleet-one'),{code:'MAINTENANCE_NOT_DRAINED'});
 blockers=['ARTIFACT_TRANSFER'];await assert.rejects(m.seal('fleet-one'),{code:'MAINTENANCE_NOT_DRAINED'});
 blockers=[];await m.seal('fleet-one');assert.throws(()=>m.assertTransfer(),{code:'SERVICE_MAINTENANCE'});
 const restarted=await createMaintenance({dataDir:dir});assert.equal(restarted.snapshot().owner,'fleet-one');assert.equal(restarted.sealed,true);
 await assert.rejects(restarted.end('other'),{code:'MAINTENANCE_OWNER_MISMATCH'});
 await restarted.end('fleet-one');restarted.assertAdmission();restarted.assertTransfer();
 assert.equal((await createMaintenance({dataDir:dir})).active,false);
});
test('maintenance prevents background power transition without changing saved power policy',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'sf-maintenance-power-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let power;const m=await createMaintenance({dataDir:dir,onEnter:()=>power?.notifyWork()});
 let inspections=0;
 power=await createPowerManager({dataDir:dir,defaults:{...powerDefaults({}),enabled:true,dry_run:true,grace_seconds:0},getBlockers:()=>m.active?['SERVICE_MAINTENANCE']:[],adapter:{supported:true,inspect:async()=>{inspections++;return {complete:true,excluded_sid:'robot',sessions:[],suspend_supported:true,suspend_privilege:true};},suspend:async()=>assert.fail('must never sleep')}});
 t.after(()=>power.close());const before=power.config;await m.begin('fleet-one');await power.request('background');assert.equal(power.status().last.reason,'SERVICE_MAINTENANCE');assert.equal(inspections,0);assert.deepEqual(power.config,before);
 await m.end('fleet-one');await power.request('api');assert.equal(power.status().last.reason,'WOULD_SUSPEND');
});
