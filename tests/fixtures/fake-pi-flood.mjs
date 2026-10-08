#!/usr/bin/env node
// Oversized-frame fixture: exercises PiRpcClient per-frame limit handling.
// 每个用例都保证进程存活、后续正常帧可处理（旧实现对 >16MiB 聚合直接杀进程）。
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const MiB = 1024 * 1024;
let deferred = null; // 'hold' 请求：响应被扣住，随下一个用例的同一批写入一起发出
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; let i; while ((i = input.indexOf('\n')) >= 0) { const line = input.slice(0, i); input = input.slice(i + 1); if (line) handle(JSON.parse(line)); } });
function handle(r) {
  const ok = data => send({ type: 'response', id: r.id, success: true, data });
  switch (r.type) {
    case 'get_state': return ok({ alive: true });
    case 'hold': deferred = r; return;
    // 完整超限帧（18MiB data）与被扣住的正常帧拼在同一次 write：验证同 chunk 恢复
    case 'flood-then-good': {
      const big = JSON.stringify({ type: 'response', id: r.id, success: true, command: 'get_messages', data: 'A'.repeat(18 * MiB) }) + '\n';
      const good = JSON.stringify({ type: 'response', id: deferred.id, success: true, data: 'held' }) + '\n';
      deferred = null;
      process.stdout.write(big + good);
      return;
    }
    // 超限帧体由多字节字符组成，且在两次 write 的字节边界处把一个 '中' 劈成两半：
    // 客户端的 StringDecoder 必须跨 chunk 拼回 UTF-8 序列；帧尾用 CRLF，紧随一条
    // 同为 CRLF 结尾的合法响应（覆盖排空路径与 CR 剥离解析路径）。
    case 'flood-crlf-split': {
      const big = JSON.stringify({ type: 'response', id: r.id, success: true, command: 'get_messages', data: '中'.repeat(6 * MiB) }) + '\r\n';
      const good = JSON.stringify({ type: 'response', id: deferred.id, success: true, data: 'held-crlf' }) + '\r\n';
      deferred = null;
      const bytes = Buffer.from(big, 'utf8');
      // '中' 是 3 字节 UTF-8（E4 B8 AD）：切割点落在帧体中段某个 '中' 的第 1 字节之后，
      // 前半以 E4 结尾、后半以 B8 AD 开头——半个字符必须等另一半到齐才能解码。
      const dataStart = Buffer.byteLength(big.slice(0, big.indexOf('中')));
      const half = Math.floor(bytes.length / 2);
      const split = dataStart + Math.floor((half - dataStart) / 3) * 3 + 1;
      process.stdout.write(bytes.subarray(0, split));
      process.stdout.write(Buffer.concat([bytes.subarray(split), Buffer.from(good, 'utf8')]));
      return;
    }
    // 多个完整小帧合计超 16MiB：逐帧检查不得误杀（旧实现按 chunk 聚合误判）
    case 'burst': {
      let out = '';
      for (let i = 0; i < 18; i++) out += JSON.stringify({ type: 'response', id: 'pad-' + i, success: true, data: 'P'.repeat(MiB) }) + '\n';
      if (deferred) { out += JSON.stringify({ type: 'response', id: deferred.id, success: true, data: 'held' }) + '\n'; deferred = null; }
      process.stdout.write(out);
      return;
    }
    // 截断的超限帧且不带换行：验证半帧也受上限约束（排空到换行为止，不无界拼接）
    case 'flood-partial': {
      process.stdout.write('{"type":"response","id":"' + r.id + '","success":true,"data":"' + 'B'.repeat(17 * MiB)); // 无换行
      return;
    }
    // 排空结束的收尾：补上 flood-partial 的帧尾，正常响应紧随其后
    case 'flood-partial-tail': {
      process.stdout.write('C'.repeat(2 * MiB) + '"}\n');
      return ok('tail-done');
    }
    // 无法识别归属的超限帧（无 id 字段）：不得错误 resolve/reject 其他 pending
    case 'flood-anon': return process.stdout.write('{"type":"response","success":true,"data":"' + 'D'.repeat(17 * MiB) + '"}\n');
    default: return send({ type: 'response', id: r.id, success: false, error: 'unsupported' });
  }
}
