import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/pi-runtime');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const piVersion=pkg.dependencies['@earendil-works/pi-coding-agent'];
const nodeVersion=pkg.dependencies.node;
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--no-audit','--no-fund'],{cwd:root,stdio:'inherit',shell:process.platform==='win32'});
if(result.error || result.status!==0)throw new Error('内置运行时安装失败');
const executable=path.join(root,'node_modules/node/bin',process.platform==='win32'?'node.exe':'node');
const cli=path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
/** pi 的 bundle 启动时用 PI_PACKAGE_DIR 覆盖自身包目录（chunk 里 getPackageDir 优先读 env）：
 *  本机装了全局 pi 时该变量会让 bundled cli 报出**全局**版本，版本自检因此失真
 *  （ bundled 1.3.0 报成 1.2.0）。清理它，让 cli.js 从自身路径解析包目录。 */
function bundledEnv(){const env={...process.env,ELECTRON_RUN_AS_NODE:undefined};delete env.PI_PACKAGE_DIR;delete env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;return env;}
const version=spawnSync(executable,[cli,'--version'],{encoding:'utf8',env:bundledEnv()});
if(version.status!==0 || version.stdout.trim()!==piVersion)throw new Error(`内置 pi 版本验证失败：期望 ${piVersion}，实际 ${version.stdout.trim()||'(无输出)'}`);
fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({platform:process.platform,arch:process.arch,pi:piVersion,node:nodeVersion},null,2));
console.log(`Private runtime ready: ${process.platform}/${process.arch}, pi ${piVersion}, Node ${nodeVersion}`);
