// Exercise the real runtime reload API in RPC tests; /reload itself is TUI-only.
export default function (pi) {
  pi.registerCommand('proof-reload', {description: 'Reload test runtime', handler: async (_args, ctx) => {await ctx.reload();}});
}
