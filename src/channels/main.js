// channels/main.js —— 主会话通道。
//
// 现状：dsh 的会话日志是 session.v4.jsonl.zstd（zstd 压缩），
// Node 22 自带 zlib 但不带 zstd 解码，硬解要么加依赖、要么调外部工具，
// 两条都不划算，所以这里明确返回「不可用」，而不是拿会话文件的 mtime 冒充
// 「她最后说话的时间」——那样我们自己的回复也会把时间顶上去，判据就假了。
export function readMain() {
  return {
    channel: 'main',
    ok: false,
    reason: 'MAIN_LOGS_ZSTD',
    note: '会话日志是 zstd 压缩，暂不解析',
    lastUserTs: null,
    lastSendTs: null,
  };
}
