// qq-send.js —— 给 dsh 调用的最小发送通道。
//
//   node src/qq-send.js --text "在吗"              默认演练，只回 payload
//   node src/qq-send.js --text "在吗" --yes        真发（还要 send.enabled=true 且 dryRun=false）
//   node src/qq-send.js --to 123456 --text "..."   临时指定收件人
//
// 输出：单行 JSON，方便被别的 agent/脚本直接消费。
import { loadConfig } from './config.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendQQPrivate, sendQQRound, bridgeInfo } from './send.js';

export async function sendQqText({ text, to, cfg = loadConfig(), confirm = false, track = false }) {
  if (!text) return { ok: false, error: '缺少 --text' };
  const peer = to ?? cfg.channels?.qq?.peerId ?? '';
  const gate = { sendEnabled: cfg.send?.enabled === true, dryRun: cfg.dryRun !== false, confirm };
  const dryRun = !(gate.sendEnabled && !gate.dryRun && gate.confirm);
  const options = { to: peer, text, dryRun, timeoutMs: cfg.send?.timeoutMs };
  const result = track
    ? await sendQQRound({ ...options, split: { enabled: false } })
    : await sendQQPrivate(options);
  return {
    ...result, to: peer, text, gate, bridge: bridgeInfo(),
    hint: dryRun ? '演练模式：需要 send.enabled=true、dryRun=false 且带 --yes 才会真发' : '',
  };
}

if (process.argv[1] && process.argv[1].endsWith('qq-send.js') && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const argOf = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const result = await sendQqText({ to: argOf('--to'), text: argOf('--text'), confirm: argv.includes('--yes') });
  console.log(JSON.stringify(result));
  if (!result.text) process.exitCode = 2;
}
