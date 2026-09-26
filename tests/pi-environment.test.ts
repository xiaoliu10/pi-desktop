import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { discoverPi, piVersionSupported, compareVersion } from '../src/main/pi/environment';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));

it('discovers a symlinked npm installation with spaces without executing it',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi env '));roots.push(root);fs.mkdirSync(path.join(root,'pkg/bin'),{recursive:true});
 fs.writeFileSync(path.join(root,'pkg/package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.85.1'}));
 fs.writeFileSync(path.join(root,'pkg/bin/pi'),'#!/bin/sh\nexit 99\n',{mode:0o755});fs.symlinkSync(path.join(root,'pkg/bin/pi'),path.join(root,'pi'));
 const env=discoverPi({executable:path.join(root,'pi'),agentDir:root,sessionDirs:[path.join(root,'other')]},{});
 expect(env.version).toBe('0.85.1');expect(env.supported).toBe(true);expect(env.sessionDirs).toContain(path.join(root,'other'));
});
it('reports an invalid executable when no bundled fallback exists',()=>{const env=discoverPi({executable:'/missing/pi',agentDir:'/missing/config'},{},'/missing/runtime');expect(env.executable).toBeNull();expect(env.supported).toBe(false);});

function bundledFixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-bundled-'));roots.push(root);const pkg=path.join(root,'node_modules/@earendil-works/pi-coding-agent');const node=path.join(root,'node_modules/node');fs.mkdirSync(path.join(pkg,'dist/bundle'),{recursive:true});fs.mkdirSync(path.join(node,'bin'),{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'0.86.0'}));fs.writeFileSync(path.join(pkg,'dist/bundle/cli.js'),'');fs.writeFileSync(path.join(node,'package.json'),JSON.stringify({version:'22.22.0'}));fs.writeFileSync(path.join(node,'bin',process.platform==='win32'?'node.exe':'node'),'unused',{mode:0o755});fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({platform:process.platform,arch:process.arch}));return root;}
/** A local pi CLI living in its own bin dir, placed on PATH so discoverExternalPi finds it. */
function localFixture(version:string){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-local-'));roots.push(root);fs.mkdirSync(path.join(root,'pkg/bin'),{recursive:true});fs.mkdirSync(path.join(root,'bin'));fs.writeFileSync(path.join(root,'pkg/package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version}));fs.writeFileSync(path.join(root,'pkg/bin/pi'),'#!/bin/sh\nexit 99\n',{mode:0o755});fs.symlinkSync(path.join(root,'pkg/bin/pi'),path.join(root,'bin/pi'));return root;}

it('uses the bundled runtime when explicitly requested, without CLI discovery',()=>{const root=bundledFixture();const env=discoverPi({runtime:'bundled',agentDir:root},{PATH:''},root);expect(env).toMatchObject({runtime:'bundled',supported:true,version:'0.86.0',fallback:false});expect(env.launchArgs?.[0]).toContain('dist/bundle/cli.js');expect(env.executable).toContain('node_modules/node/bin');});
it('explicitly reports fallback for a missing custom CLI',()=>{const root=bundledFixture();expect(discoverPi({runtime:'custom',executable:'/missing/pi'}, {},root)).toMatchObject({runtime:'bundled',requestedRuntime:'custom',fallback:true,supported:true});});
it('rejects a bundled runtime built for a different architecture',()=>{const root=bundledFixture();fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({platform:process.platform,arch:'wrong'}));expect(discoverPi({runtime:'bundled'}, {},root).supported).toBe(false);});

it('auto (the default) prefers a compatible local CLI over the bundled pi',()=>{
  const local=localFixture('0.87.0');const bundled=bundledFixture();
  const env=discoverPi({agentDir:local},{PATH:path.join(local,'bin')},bundled);
  expect(env).toMatchObject({runtime:'system',requestedRuntime:'auto',version:'0.87.0',supported:true,fallback:false});
  expect(env.executable).toBe(path.join(local,'bin/pi'));
  expect(env.bundledVersion).toBe('0.86.0');
  expect(env.systemVersion).toBe('0.87.0');
  expect(env.systemSupported).toBe(true);
  expect(env.launchArgs).toBeUndefined();
});
it('auto falls back to the bundled pi when the local CLI is below the supported range',()=>{
  const local=localFixture('0.84.0');const bundled=bundledFixture();
  const env=discoverPi({agentDir:local},{PATH:path.join(local,'bin')},bundled);
  expect(env).toMatchObject({runtime:'bundled',requestedRuntime:'auto',version:'0.86.0',supported:true,fallback:true});
  expect(env.systemVersion).toBe('0.84.0');
  expect(env.systemSupported).toBe(false);
  expect(env.bundledVersion).toBe('0.86.0');
});
it('accepts pi 0.85.1 and 0.87.0 as supported, rejects 0.84.0',()=>{
  expect(piVersionSupported('0.85.1')).toBe(true);
  expect(piVersionSupported('0.86.0')).toBe(true);
  expect(piVersionSupported('0.87.0')).toBe(true);
  expect(piVersionSupported('0.84.0')).toBe(false);
  expect(piVersionSupported(null)).toBe(false);
});
it('treats 0.90.0 as an exclusive external CLI compatibility bound',()=>{
  expect(piVersionSupported('0.89.9')).toBe(process.platform !== 'win32');
  expect(piVersionSupported('0.90.0')).toBe(false);
  expect(piVersionSupported('0.91.0')).toBe(false);
  const local=localFixture('0.90.0');const bundled=bundledFixture();
  expect(discoverPi({agentDir:local},{PATH:path.join(local,'bin')},bundled))
    .toMatchObject({runtime:'bundled',requestedRuntime:'auto',supported:true,fallback:true,systemSupported:false});
});
it('compares versions numerically per segment',()=>{
  expect(compareVersion('0.86.0','0.86.0')).toBe(0);
  expect(compareVersion('0.87.0','0.86.0')).toBe(1);
  expect(compareVersion('0.85.1','0.86.0')).toBe(-1);
  expect(compareVersion('0.90.0','0.89.10')).toBe(1);
});
