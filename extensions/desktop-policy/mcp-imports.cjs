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

/**
 * Normalize relative cwd/command in imported server configs. Some tools write
 * relative paths (codex: `command = "./X.app/…/bin"`, `cwd = "."` resolved
 * against its own working directory, which is not reproducible here). Strategy:
 * resolve cwd against the source file's directory, then try the command against
 * [resolved cwd, baseDir]; if still absent, shallow-search baseDir for the
 * command's first path segment and adopt the unique hit (cwd follows it).
 * Absolute paths and URL servers pass through untouched.
 */
function normalizeServerPaths(config, baseDir) {
  if (!config || typeof config !== 'object' || !config.command || typeof config.command !== 'string') return config;
  const absolute = (p) => path.isAbsolute(p) ? p : path.resolve(baseDir, p);
  const cwd = typeof config.cwd === 'string' && config.cwd ? absolute(config.cwd) : baseDir;
  let command = config.command;
  let resolvedCwd = cwd;
  if (!path.isAbsolute(command)) {
    const candidates = [path.resolve(cwd, command), path.resolve(baseDir, command)];
    const hit = candidates.find(candidate => fs.existsSync(candidate));
    if (hit) {
      command = hit;
    } else {
      const rel = command.replace(/^(?:\.[\\/])+/, ''); // './MyTool.app/…' → 'MyTool.app/…'
      const first = rel.split('/')[0].split('\\')[0];
      const hits = first && first !== '..' ? shallowFind(baseDir, first, 3) : [];
      if (hits.length !== 1) return config; // unresolvable — keep as written; connect/test will report it
      command = path.join(hits[0], rel.slice(first.length + 1));
      // cwd follows the discovered segment's directory (the tool's own root).
      resolvedCwd = path.dirname(hits[0]);
    }
  }
  return { ...config, command, cwd: resolvedCwd };
}

/** Depth-limited search for entries named `name`; returns containing directories. */
function shallowFind(dir, name, depth) {
  const hits = [];
  if (depth < 0 || !fs.existsSync(dir)) return hits;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return hits; }
  for (const entry of entries) {
    if (entry.name === name) hits.push(path.join(dir, entry.name));
    else if (entry.isDirectory() && !entry.name.startsWith('.')) hits.push(...shallowFind(path.join(dir, entry.name), name, depth - 1));
    if (hits.length > 1) break;
  }
  return hits;
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
          out.push({ name: serverName, config: normalizeServerPaths(config, path.dirname(src.file)), source: name, file: src.file });
        }
      }
    } catch { /* missing/unreadable source config is fine — skip it */ }
  }
  return out;
}

module.exports = { resolveImports, readTomlServers, normalizeServerPaths, SOURCES };
