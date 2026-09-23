// Resolve pi's mcp.json `imports` (external MCP sources like claude-code/cursor/codex/
// opencode/claude-desktop) into concrete {name, config, source, file} entries. pi's native
// loader imports these; the desktop mcp-bridge only ever read `mcpServers` directly, so
// imported servers never loaded in desktop. This closes that gap (shared by bridge + settings).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const home = os.homedir();

// import source name → where that tool stores its MCP servers. Mirrors pi's `imports` keys.
const SOURCES = {
  'claude-code': { file: path.join(home, '.claude.json'), key: 'mcpServers' },
  'cursor': { file: path.join(home, '.cursor/mcp.json'), key: 'mcpServers' },
  'claude-desktop': {
    file: process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
      : path.join(home, 'AppData/Roaming/Claude/claude_desktop_config.json'),
    key: 'mcpServers',
  },
  'opencode': { file: path.join(home, '.config/opencode/opencode.json'), key: 'mcpServers' },
  'codex': { file: path.join(home, '.codex/config.toml'), key: 'mcp_servers', toml: true },
};

// Minimal TOML scan for codex: `[mcp_servers.NAME]` sections with command/args/url.
function readTomlServers(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const servers = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const section = /^\[mcp_servers\.([^\]]+)\]/.exec(line) || /^\[mcp_servers\]\]/.exec(line);
    const named = /^\[mcp_servers\.([^\].]+)(?:\.[^\]]+)?\]/.exec(line);
    if (named) { cur = named[1]; servers[cur] = servers[cur] || {}; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1], val = kv[2].trim();
    if (key === 'command') servers[cur].command = val.replace(/^["']|["']$/g, '');
    else if (key === 'url') servers[cur].url = val.replace(/^["']|["']$/g, '');
    else if (key === 'disabled' || key === 'enabled') {
      if (val === 'true' || val === 'false') servers[cur][key] = val === 'true';
    }
    else if (key === 'args') {
      try { servers[cur].args = JSON.parse(val.replace(/'/g, '"')); } catch { /* array literals vary */ }
    }
  }
  return servers;
}

/** Return [{ name, config, source, file }] for every import source that resolves. */
function resolveImports(imports) {
  const out = [];
  for (const name of Array.isArray(imports) ? imports : []) {
    const src = SOURCES[name];
    if (!src) continue;
    try {
      let servers;
      if (src.toml) servers = readTomlServers(src.file);
      else { const cfg = JSON.parse(fs.readFileSync(src.file, 'utf8')); servers = cfg[src.key] || cfg.mcpServers || {}; }
      for (const [serverName, config] of Object.entries(servers || {})) {
        if (config && typeof config === 'object' && (config.command || config.url)) {
          out.push({ name: serverName, config, source: name, file: src.file });
        }
      }
    } catch { /* missing/unreadable source config is fine — skip it */ }
  }
  return out;
}

module.exports = { resolveImports, readTomlServers, SOURCES };
