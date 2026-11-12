// imap.js —— 极简 IMAP4rev1 客户端。
//
// 只实现本插件用得到的四件事：登录、选箱、按序号取最近几封、登出。
// 不实现 IDLE / STORE / APPEND / MOVE —— 用不到的协议面越小，出错的地方越少。
// 零依赖：直接对着 node:tls 说话，跟自写的 SMTP 一个路子。
//
// 一个容易踩的坑：FETCH 里带 BODY[] 时服务器会回「字面量」(literal)：
//   * 12 FETCH (UID 456 BODY[] {1234}\r\n<1234 字节原始邮件>)\r\n
// 所以读响应不能按行读，必须先看行尾的 {n}，再精确读 n 个字节，然后再继续按行读。
import net from 'node:net';
import tls from 'node:tls';

const CRLF = Buffer.from('\r\n');

export class ImapError extends Error {
  constructor(status, text, command) {
    super(`IMAP ${status}: ${String(text || '').slice(0, 200)}`);
    this.name = 'ImapError';
    this.status = status;
    this.text = text;
    this.command = command;
  }
}

/** 把 socket 变成「可以按行读、也可以按字节读」的流。 */
class Reader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._wake();
    });
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('IMAP 连接已关闭')));
  }

  _wake() {
    const p = this.pending;
    if (p) {
      this.pending = null;
      p.resolve();
    }
  }

  _fail(e) {
    if (!this.error) this.error = e;
    const p = this.pending;
    if (p) {
      this.pending = null;
      p.reject(e);
    }
  }

  _wait() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** 读一行（不含 CRLF）。行内的非 ASCII 按 UTF-8 解，够我们用。 */
  async line() {
    for (;;) {
      const i = this.buf.indexOf(CRLF);
      if (i >= 0) {
        const s = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return s;
      }
      if (this.error) throw this.error;
      await this._wait();
    }
  }

  /** 精确读 n 个字节（邮件原文，可能是任意字节）。 */
  async bytes(n) {
    while (this.buf.length < n) {
      if (this.error) throw this.error;
      await this._wait();
    }
    const out = Buffer.from(this.buf.subarray(0, n)); // 复制，别让上层持有整个缓冲
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** IMAP 字符串：加引号并转义，避免邮箱地址/授权码里的特殊字符把命令拆坏。 */
function quote(s) {
  return `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
}

export class ImapClient {
  constructor(socket, { timeoutMs = 20000, tagPrefix = 'a' } = {}) {
    this.socket = socket;
    this.reader = new Reader(socket);
    this.timeoutMs = timeoutMs;
    this.tagPrefix = tagPrefix;
    this.seq = 0;
  }

  /**
   * 连上并等服务器问好。
   * secure=true 走 993 隐式 TLS；secure=false 只给本地假服务器测试用。
   */
  static async connect({ host, port = 993, secure = true, timeoutMs = 20000, rejectUnauthorized = true } = {}) {
    if (!host) throw new Error('缺少 IMAP 主机名');
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized })
      : net.connect({ host, port });

    // 握手/建连都要有上限，否则网络半通会一直挂着
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`IMAP 连接超时（${timeoutMs}ms）`)));

    await new Promise((resolve, reject) => {
      const evt = secure ? 'secureConnect' : 'connect';
      const onOk = () => {
        socket.off('error', onErr);
        resolve();
      };
      const onErr = (e) => {
        socket.off(evt, onOk);
        reject(e);
      };
      socket.once(evt, onOk);
      socket.once('error', onErr);
    });

    const client = new ImapClient(socket, { timeoutMs });
    const greet = await client.reader.line();
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(greet)) {
      socket.destroy();
      throw new ImapError('NO', greet, 'greeting');
    }
    return client;
  }

  /** 写一条命令，返回它的 tag。 */
  _send(cmd) {
    this.seq += 1;
    const tag = `${this.tagPrefix}${String(this.seq).padStart(3, '0')}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    return tag;
  }

  /** 读到该 tag 的完成行为止；顺带把字面量取出来。 */
  async _read(tag) {
    const lines = [];
    for (;;) {
      const line = await this.reader.line();
      const m = /\{(\d+)\}$/.exec(line);
      if (m) {
        // 字面量：紧跟 CRLF 后面的 n 个字节，之后再回到按行读
        const literal = await this.reader.bytes(Number(m[1]));
        lines.push({ text: line, literal });
        continue;
      }
      lines.push({ text: line });
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1).trim();
        const status = (rest.split(/\s+/)[0] || '').toUpperCase();
        return { status, ok: status === 'OK', text: rest, lines };
      }
      if (/^\*\s+BYE\b/i.test(line)) throw new ImapError('BYE', line, tag);
    }
  }

  async run(cmd) {
    return this._read(this._send(cmd));
  }

  /** 跑一条命令，非 OK 直接抛。 */
  async exec(cmd) {
    const r = await this.run(cmd);
    if (!r.ok) throw new ImapError(r.status, r.text, cmd);
    return r;
  }

  async login(user, pass) {
    // CAPABILITY 有些服务器不要求，失败也别当致命错误
    await this.exec('CAPABILITY').catch(() => {});
    const r = await this.run(`LOGIN ${quote(user)} ${quote(pass)}`);
    if (!r.ok) {
      const authy = /auth|login|fail|invalid|wrong|denied/i.test(r.text);
      // 提示放前面：服务器那句话很长，截断后容易把关键信息切掉
      const text = authy
        ? `认证失败（QQ 邮箱要填「IMAP 授权码」，不是登录密码）— ${r.text.slice(0, 120)}`
        : r.text;
      throw new ImapError(r.status, text, 'LOGIN');
    }
    return r;
  }

  /** 选中信箱，返回邮件总数。 */
  async select(mailbox = 'INBOX') {
    const r = await this.exec(`SELECT ${quote(mailbox)}`);
    let exists = 0;
    let uidNext = null;
    for (const { text } of r.lines) {
      const e = /^\*\s+(\d+)\s+EXISTS/i.exec(text);
      if (e) exists = Number(e[1]);
      const u = /\[UIDNEXT\s+(\d+)\]/i.exec(text);
      if (u) uidNext = Number(u[1]);
    }
    return { exists, uidNext };
  }

  /**
   * 取最近 count 封的原文（BODY.PEEK[]，不会把邮件标成已读）。
   * 返回 [{ seq, uid, raw: Buffer }]，按服务器顺序（旧的在前）。
   */
  async fetchRecent(count = 5, exists = null) {
    const total = exists == null ? (await this.select()).exists : exists;
    if (!total) return [];

    const from = Math.max(1, total - Math.max(1, count) + 1);
    const r = await this.exec(`FETCH ${from}:* (UID BODY.PEEK[])`);

    const out = [];
    let cur = null;
    for (const item of r.lines) {
      const text = item.text || '';
      const start = /^\*\s+(\d+)\s+FETCH\b/i.exec(text);
      if (start) cur = { seq: Number(start[1]), uid: null, raw: null };
      if (!cur) continue;
      const u = /\bUID\s+(\d+)/i.exec(text);
      if (u) cur.uid = Number(u[1]);
      if (item.literal) {
        cur.raw = item.literal;
        out.push(cur);
        cur = null;
      }
    }
    return out;
  }

  async logout() {
    try {
      await this.exec('LOGOUT');
    } catch {
      /* 服务器可能已经断了，无所谓 */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}
