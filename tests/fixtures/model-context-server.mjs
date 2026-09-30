// Synthetic browser bridge. Writes only a mkdtemp fixture; never calls a provider.
// node tests/fixtures/model-context-server.mjs (port 5186)
import { createServer } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-context-browser-'));
const file = path.join(dir, 'models.json');
fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
const seed = () => fs.writeFileSync(file, JSON.stringify({ providers: Object.fromEntries(['alpha','beta'].map(id => [id, {
  name: id === 'alpha' ? 'Alpha' : 'Beta', baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: 'fixture-only', headers: { keep: 'fixture-header' },
  models: [{ id: 'shared', name: 'Shared', contextWindow: 1000000, maxTokens: 32000, unknown: { keep: true } }],
}])) }));
seed();
let bridge;
const server = await createServer({ plugins: [{ name: 'synthetic-context-bridge', configureServer(server) { server.middlewares.use('/__context', (req, res) => bridge(req, res)); } }], server: { host: '127.0.0.1', port: 5186, strictPort: true } });
const { readModelCatalog, mergeModelCatalog, writeModelProvider } = await server.ssrLoadModule(path.resolve('src/main/pi/model-catalog.ts'));
const { ModelRuntime } = await import(pathToFileURL(path.resolve('resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js')).href);
const native = ['alpha','beta'].map(id => ({ id, name: id, source: 'auth', auth: 'api_key', models: [{ id: 'shared', contextWindow: 1000000, maxTokens: 32000 }] }));
let saves = [];
bridge = async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let value;
    if (req.url === '/reset') { seed(); saves = []; value = {}; }
    else if (req.url === '/catalog') value = mergeModelCatalog(readModelCatalog(dir), structuredClone(native));
    else if (req.url === '/save') { const draft = JSON.parse(raw); saves.push(draft); value = writeModelProvider(dir, draft); }
    else if (req.url === '/external') {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(doc.providers.alpha, { name: 'External Alpha', apiKey: 'rotated-fixture', extra: 'external' });
      doc.providers.alpha.models.push({ id: 'externally-added', contextWindow: 64000 });
      fs.writeFileSync(file, JSON.stringify(doc)); value = {};
    } else if (req.url === '/inspect') {
      const runtime = await ModelRuntime.create({ modelsPath: file, authPath: path.join(dir, 'auth.json'), allowModelNetwork: false });
      value = { doc: JSON.parse(fs.readFileSync(file, 'utf8')), saves, effective: runtime.getModel('alpha','shared').contextWindow, upstream: 1000000 };
    } else throw Error('unknown fixture operation');
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value));
  } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
};
await server.listen(); console.log('Synthetic context fixture ready on 5186');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await server.close(); fs.rmSync(dir,{recursive:true,force:true}); process.exit(0); });
