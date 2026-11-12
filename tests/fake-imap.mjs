// tests/fake-imap.mjs —— 本地假 IMAP 服务器，只回本客户端会发的那几条命令。
// 用明文 TCP（ImapClient 支持 secure=false），这样测试不需要证书。
import net from 'node:net';

export function startFakeImap({ messages = [], invalidAuth = false } = {}) {
  const seen = [];

  const server = net.createServer((socket) => {
    let buf = '';
    socket.write('* OK [CAPABILITY IMAP4rev1] fake imap ready\r\n');

    const handle = (line) => {
      seen.push(line);
      const sp = line.indexOf(' ');
      const tag = sp < 0 ? line : line.slice(0, sp);
      const cmd = sp < 0 ? '' : line.slice(sp + 1);
      const upper = cmd.toUpperCase();

      if (upper.startsWith('CAPABILITY')) {
        socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        return;
      }
      if (upper.startsWith('LOGIN')) {
        socket.write(
          invalidAuth
            ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`
            : `${tag} OK LOGIN completed\r\n`
        );
        return;
      }
      if (upper.startsWith('SELECT')) {
        socket.write(`* ${messages.length} EXISTS\r\n* OK [UIDNEXT 9999] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
        return;
      }
      if (upper.startsWith('FETCH')) {
        const m = /^FETCH\s+(\d+):\*/i.exec(cmd);
        const from = m ? Number(m[1]) : 1;
        const bufs = [];
        for (let i = from - 1; i < messages.length; i++) {
          const { uid, raw } = messages[i];
          bufs.push(Buffer.from(`* ${i + 1} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`, 'utf8'));
          bufs.push(raw);
          bufs.push(Buffer.from(')\r\n', 'utf8'));
        }
        bufs.push(Buffer.from(`${tag} OK FETCH completed\r\n`, 'utf8'));
        socket.write(Buffer.concat(bufs));
        return;
      }
      if (upper.startsWith('LOGOUT')) {
        socket.write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }
      socket.write(`${tag} BAD unknown command\r\n`);
    };

    socket.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handle(line);
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
