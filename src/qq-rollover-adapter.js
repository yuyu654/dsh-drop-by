import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './outbound.js';

export function stripQqSourceHeader(text) {
  if (!/^\[QQ (?:私聊|群聊)\] /u.test(text)) return text;
  const end = text.indexOf('\n\n');
  if (end < 0) return text;
  const body = text.slice(end + 2).replace(/^\[\d{2}:\d{2}:\d{2}\] /gmu, '');
  return body.split('\n\n附件：\n', 1)[0];
}

export function qqRolloverAdapter(home = dshHome()) {
  const file = path.join(home, 'qq-bridge', 'bindings.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    stripSourceHeader: stripQqSourceHeader,
    bindingFor(sessionId) {
      const entry = read().sessions?.[sessionId];
      return entry?.enabled !== false && entry?.peerId
        ? { peerId: String(entry.peerId), peerKind: entry.peerKind } : null;
    },
    bindingMeta(sessionId) {
      const entry = read().sessions?.[sessionId];
      return entry?.peerId ? {
        peerId: String(entry.peerId),
        peerKind: entry.peerKind,
        peerName: String(entry.peerName || ''),
        mentionOnly: entry.mentionOnly === true,
        authoritative: entry.authoritative === true,
        enabled: entry.enabled !== false,
      } : null;
    },
    activeSessionForPeer(peerId) {
      const target = String(peerId || '').trim();
      if (!target) return null;
      const sessions = read().sessions || {};
      const matches = Object.entries(sessions)
        .filter(([, entry]) => entry && entry.enabled !== false && entry.peerKind === 'private' && String(entry.peerId) === target)
        .map(([sessionId, entry]) => ({
          sessionId,
          peerId: String(entry.peerId),
          peerKind: entry.peerKind,
          peerName: String(entry.peerName || ''),
          authoritative: entry.authoritative === true,
          updatedAt: Number(entry.updatedAt) || 0,
        }))
        .sort((a, b) => Number(b.authoritative) - Number(a.authoritative) || b.updatedAt - a.updatedAt);
      return matches[0] || null;
    },
    prepareBinding({ oldSessionId, newSessionId, peerId, peerKind, triggeredAt }) {
      const data = read();
      const entry = data.sessions?.[oldSessionId];
      if (!entry || entry.enabled === false || String(entry.peerId) !== peerId || entry.peerKind !== peerKind) return false;
      data.sessions[oldSessionId] = { ...entry, enabled: false, updatedAt: triggeredAt };
      data.sessions[newSessionId] = { ...entry, sessionId: newSessionId, enabled: true, updatedAt: triggeredAt };
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      return true;
    },
  };
}
