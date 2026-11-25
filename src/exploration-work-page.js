import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList } from 'node:net';

const excluded = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
]) excluded.addSubnet(address, bits, 'ipv4');

function publicLookup(host, options, callback) {
  lookup(host, { ...options, all: true }, (error, records) => {
    if (error) return callback(error);
    const addresses = records.filter(({ address, family }) => family === 4
      ? !excluded.check(address, 'ipv4')
      : /^[23]/i.test(address));
    if (!addresses.length) return callback(new Error('WORK_SOURCE_ADDRESS_BLOCKED'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export const isLoginPage = (url) => /(?:^|[./_-])(?:login|signin|sign-in|passport)(?:[./?_-]|$)/i.test(
  String(url || '').replace(/^https?:\/\//i, ''),
);

function readPage(url, signal) {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { signal, lookup: publicLookup, agent: false, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
    } }, (res) => {
      const status = res.statusCode;
      const location = res.headers.location;
      if (status < 200 || status >= 300) {
        resolve({ status, location, body: '' });
        res.destroy();
        return;
      }
      res.setEncoding('utf8');
      res.on('error', reject);
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length >= 262_144) {
          resolve({ status, body: body.slice(0, 262_144) });
          res.destroy();
        }
      });
      res.on('end', () => resolve({ status, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Check scope before issuing every request, including each redirect. */
export async function fetchWorkPage(url, { allow, signal, read = readPage }) {
  let current = new URL(url);
  for (let hop = 0; hop < 5 && allow(current.href); hop += 1) {
    signal?.throwIfAborted();
    const page = await read(current, signal);
    if (page.status === 401 || isLoginPage(current)) return { login: true };
    if (page.status >= 300 && page.status < 400 && page.location) {
      const next = new URL(page.location, current);
      if (isLoginPage(next)) return { login: true };
      current = next;
      continue;
    }
    return { url: current.href, statusCode: page.status, body: { content: page.body } };
  }
  return null;
}
