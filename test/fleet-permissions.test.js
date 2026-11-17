import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {privateDirectory,protectWindowsDirectory} from '../fleet/common.mjs';

test('Windows directory permission invocation uses literal encoded paths and does not run a shell',async()=>{
 const directory='C:\\Deploy\\Отчеты & $(do-not-execute)';let call;
 await protectWindowsDirectory(directory,async(...args)=>{call=args;});
 assert.equal(call[0],'powershell.exe');assert.equal(call[2].windowsHide,true);assert.equal(call[2].shell,undefined);
 const source=Buffer.from(call[1].at(-1),'base64').toString('utf16le');
 assert.ok(source.includes(Buffer.from(directory).toString('base64')));assert.ok(!source.includes(directory));
});
test('permission failures are bounded and do not expose encoded commands or continue',async()=>{
 await assert.rejects(protectWindowsDirectory('C:\\Deploy\\enrollments',async()=>{throw new Error('Command failed: powershell.exe -EncodedCommand LARGE_CLIXML');}),error=>{
  assert.equal(error.code,'DIRECTORY_PERMISSION_ERROR');assert.equal(error.statusCode,403);assert.match(error.message,/enrollments/);assert.match(error.message,/Файлы с ключами не записаны/);assert.doesNotMatch(String(error),/EncodedCommand|CLIXML/);assert.equal(error.cause,undefined);return true;
 });
});
test('privateDirectory remains idempotent for a directory owned by the current user',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'sf-permissions-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'protected');
 await privateDirectory(directory);await privateDirectory(directory);const info=await stat(directory);assert.ok(info.isDirectory());if(process.platform!=='win32')assert.equal(info.mode&0o777,0o700);
});
