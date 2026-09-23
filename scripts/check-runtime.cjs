const fs=require('node:fs');const path=require('node:path');
module.exports=async context=>{
 const dir=path.join(context.packager.projectDir,'resources/pi-runtime');
 const runtime=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'),'utf8'));
 const arch=require(require.resolve('builder-util',{paths:[path.dirname(require.resolve('electron-builder'))]})).Arch[context.arch];
 if(runtime.platform!==context.electronPlatformName||runtime.arch!==arch)throw new Error(`运行时架构不匹配：请在 ${context.electronPlatformName}/${arch} 上运行 pnpm runtime:prepare 后打包`);
 for(const file of ['node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js','node_modules/node/bin/'+(runtime.platform==='win32'?'node.exe':'node')])if(!fs.existsSync(path.join(dir,file)))throw new Error('运行时不完整，请运行 pnpm runtime:prepare');
};
