// mime.js —— 邮件原文 → { from, subject, date, text }。
//
// 只解析我们这个场景真正会遇到的形状：单段 text/plain（鱼鱼状态就是这么发的），
// 外加 multipart/alternative 的兜底。不处理附件、内嵌图片、PGP —— 遇到了就当没有。
//
// 两个必须做的事：RFC 2047 主题解码（=?UTF-8?B?...?=）和 Content-Transfer-Encoding 解码。

const CRLF2 = Buffer.from('\r\n\r\n');
const LF2 = Buffer.from('\n\n');

/** 拆头部与正文。 */
export function splitMessage(buf) {
  let i = buf.indexOf(CRLF2);
  let skip = 4;
  if (i < 0) {
    i = buf.indexOf(LF2);
    skip = 2;
  }
  if (i < 0) return { head: buf.toString('utf8'), body: Buffer.alloc(0) };
  return { head: buf.subarray(0, i).toString('utf8'), body: buf.subarray(i + skip) };
}

/** 头字段展开（折行以空格/制表符开头）并统一小写键。 */
export function parseHeaders(head) {
  const out = {};
  let cur = null;
  for (const line of String(head || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) {
      out[cur] += ` ${line.trim()}`;
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    cur = line.slice(0, i).trim().toLowerCase();
    out[cur] = line.slice(i + 1).trim();
  }
  return out;
}

/** 按 charset 把字节解成字符串；中文邮件常见 utf-8 / gbk。 */
export function decodeCharset(bytes, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().trim().replace(/^["']|["']$/g, '');
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return bytes.toString('utf8');
  }
  if (cs.startsWith('utf-8')) return bytes.toString('utf8');
  try {
    // Node 自带完整 ICU，gb18030 能解 gb2312/gbk
    return new TextDecoder(cs === 'gb2312' || cs === 'gbk' ? 'gb18030' : cs).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** quoted-printable → 字节（先干掉软换行 =CRLF）。 */
function decodeQPToBuffer(s) {
  const text = String(s).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const hex = text.slice(i + 1, i + 3);
    if (c === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047：=?charset?B|Q?data?= ，相邻段之间的空白要去掉。 */
export function decodeWords(s) {
  if (!s) return '';
  return String(s)
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (all, charset, enc, data) => {
      try {
        const bytes =
          enc.toUpperCase() === 'B'
            ? Buffer.from(data.replace(/\s+/g, ''), 'base64')
            : decodeQPToBuffer(data.replace(/_/g, ' '));
        return decodeCharset(bytes, charset);
      } catch {
        return all;
      }
    });
}

/** Content-Type: text/plain; charset=UTF-8; boundary="..." */
function contentType(v) {
  const s = String(v || 'text/plain').trim();
  const semi = s.indexOf(';');
  const type = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase() || 'text/plain';
  const params = {};
  if (semi >= 0) {
    for (const piece of s.slice(semi + 1).split(';')) {
      const i = piece.indexOf('=');
      if (i < 0) continue;
      params[piece.slice(0, i).trim().toLowerCase()] = piece
        .slice(i + 1)
        .trim()
        .replace(/^"|"$/g, '');
    }
  }
  return { type, params };
}

export function decodeTransfer(buf, cte, charset) {
  const enc = String(cte || '').toLowerCase().trim();
  if (enc === 'base64') {
    const b64 = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return decodeCharset(Buffer.from(b64, 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    return decodeCharset(decodeQPToBuffer(buf.toString('latin1')), charset);
  }
  return decodeCharset(buf, charset);
}

/** 兜底：真拿到 text/html 时剥标签，保留可读文字。 */
function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** multipart 里挑「最像正文」的那一段。整体按 latin1 走，保证字节切片不错位。 */
function multipartText(body, boundary) {
  const raw = body.toString('latin1');
  const chunks = raw.split(`--${boundary}`);
  const plains = [];
  const htmls = [];

  for (let c of chunks) {
    if (!c || c.startsWith('--')) continue; // 结束标记 --boundary--
    c = c.replace(/^\r?\n/, '');
    const { head, body: b } = splitMessage(Buffer.from(c, 'latin1'));
    const h = parseHeaders(head);
    const { type, params } = contentType(h['content-type']);
    const cte = h['content-transfer-encoding'] || '';

    if (type.startsWith('multipart/') && params.boundary) {
      const nested = multipartText(b, params.boundary);
      if (nested) plains.push(nested);
    } else if (type === 'text/plain') {
      plains.push(decodeTransfer(b, cte, params.charset));
    } else if (type === 'text/html') {
      htmls.push(decodeTransfer(b, cte, params.charset));
    }
  }

  if (plains.length) return plains.join('\n');
  if (htmls.length) return stripHtml(htmls.join('\n'));
  return '';
}

function normalizeNewlines(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** 解析一封完整邮件。 */
export function parseMessage(buf) {
  const { head, body } = splitMessage(buf);
  const h = parseHeaders(head);
  const { type, params } = contentType(h['content-type']);
  const cte = h['content-transfer-encoding'] || '';

  const text =
    type.startsWith('multipart/') && params.boundary
      ? multipartText(body, params.boundary)
      : decodeTransfer(body, cte, params.charset);

  const dateStr = h.date || '';
  const ts = Date.parse(dateStr);

  return {
    from: decodeWords(h.from || ''),
    subject: decodeWords(h.subject || ''),
    date: dateStr,
    dateTs: Number.isFinite(ts) ? ts : null,
    text: normalizeNewlines(text),
  };
}
