import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
export async function executionSmoke(win: BrowserWindow, output: string) {
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const wait = () => new Promise(r => setTimeout(r, 120));
  fs.mkdirSync(output, { recursive: true });
  const initial = await js(`({groups:document.querySelectorAll('.pi-execution').length,open:document.querySelectorAll('.pi-execution[open],.pi-execution details[open]').length,tools:document.querySelectorAll('.pi-execution .pi-tool').length})`);
  if (initial.groups !== 1 || initial.open !== 0 || initial.tools !== 2) throw new Error('Unexpected execution grouping: ' + JSON.stringify(initial));
  fs.writeFileSync(path.join(output, 'execution-collapsed.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.pi-execution > summary').click()`); await wait();
  if (!await js(`document.querySelector('.pi-execution').open && document.querySelectorAll('.pi-execution details[open]').length === 0`)) throw new Error('First disclosure did not keep children collapsed');
  fs.writeFileSync(path.join(output, 'execution-steps.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.pi-execution__note > summary').click(); document.querySelector('.pi-tool summary').click()`); await wait();
  if (!await js(`document.querySelector('.pi-execution__note').open && document.querySelector('.pi-tool details').open`)) throw new Error('Nested disclosures failed');
  fs.writeFileSync(path.join(output, 'execution-detail.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.pi-execution > summary').click(); document.querySelector('.pi-execution > summary').click()`); await wait();
  if (!await js(`document.querySelector('.pi-tool details').open`)) throw new Error('Inner disclosure lost user selection');
  return { groupedTools: 2, twoLevelDisclosure: true, preservesExpansion: true };
}
