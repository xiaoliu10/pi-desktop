#!/usr/bin/env node
// Deliberately never creates the --session file: empty runtime sessions persist lazily.
// This keeps backend-created headers observable instead of masking missing persistence.
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  const ok = data => send({ type: 'response', id: request.id, success: true, data });
  switch (request.type) {
    case 'get_state':
      send({ type: 'extension_ui_request', id: 'policy', method: 'setStatus', statusKey: 'desktop-policy', statusText: '工具权限：逐次确认' });
      return ok({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    case 'get_available_models': return ok({ models: [] });
    case 'get_commands': return ok({ commands: [] });
    case 'get_available_thinking_levels': return ok({ levels: ['off'] });
    case 'get_session_stats': return ok({});
    case 'prompt': return ok({ disposition: 'started' });
    default: return ok({});
  }
});
