// qq-send.js —— 给 dsh 调用的最小发送通道。
//
//   node src/qq-send.js --text "在吗"              默认演练，只回 payload
//   node src/qq-send.js --text "在吗" --yes        真发（还要 send.enabled=true 且 dryRun=false）
//   node src/qq-send.js --to 123456 --text "..."   临时指定收件人
//
// 输出：单行 JSON，方便被别的 agent/脚本直接消费。
import { loadConfig } from './config.js';
import { sendQQPrivate, bridgeInfo } from './send.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const cfg = loadConfig();
const text = argOf('--text', '');
const to = argOf('--to', cfg.channels?.qq?.peerId || '');
const yes = argv.includes('--yes');

if (!text) {
  console.log(JSON.stringify({ ok: false, error: '缺少 --text' }));
  process.exit(2);
}

const gate = {
  sendEnabled: cfg.send?.enabled === true,
  dryRun: cfg.dryRun !== false,
  confirm: yes,
};
const dryRun = !(gate.sendEnabled && !gate.dryRun && gate.confirm);

const r = await sendQQPrivate({ to, text, dryRun });
console.log(
  JSON.stringify({
    ...r,
    to,
    text,
    gate,
    bridge: bridgeInfo(),
    hint: dryRun
      ? '演练模式：需要 send.enabled=true、dryRun=false 且带 --yes 才会真发'
      : '',
  })
);
