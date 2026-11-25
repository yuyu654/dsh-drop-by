import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkPage } from '../src/exploration-work-page.js';
import { openCdpTab } from '../src/explore-browser.js';

const root = 'https://publisher.example.org/';
const allow = url => new URL(url).origin === new URL(root).origin;

test('work HTTP redirects are checked before reading a new destination', async () => {
  const requested = [];
  const response = await fetchWorkPage(root, { allow, read(url) {
    requested.push(url.href);
    return url.pathname === '/'
      ? { status: 302, location: '/chapter/1' }
      : { status: 302, location: 'https://unapproved.example.net/repost' };
  } });
  assert.deepEqual(requested, [root, root + 'chapter/1']);
  assert.equal(response, null);
});

test('an external login redirect becomes a login prompt without visiting the destination', async () => {
  const requested = [];
  const response = await fetchWorkPage(root, { allow, read(url) {
    requested.push(url.href);
    return { status: 302, location: 'https://passport.example.org/login' };
  } });
  assert.deepEqual(requested, [root]);
  assert.deepEqual(response, { login: true });
});

test('Chrome DevTools blocks an unapproved navigation before loading it and only closes the owned tab', async (t) => {
  const oldFetch = globalThis.fetch;
  const OldWebSocket = globalThis.WebSocket;
  t.after(() => {
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = OldWebSocket;
  });

  const closed = [];
  globalThis.fetch = async (address) => {
    const { pathname } = new URL(address);
    if (pathname === '/json/version') return { ok: true };
    if (pathname === '/json/new') return { ok: true, json: async () => ({ id: 'owned', webSocketDebuggerUrl: 'ws://127.0.0.1/owned' }) };
    closed.push(pathname);
    return { ok: true };
  };

  const decisions = [];
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    post(msg) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) })));
    }

    send(text) {
      const message = JSON.parse(text);
      if (message.method === 'Page.navigate') {
        this.navigation = message.id;
        this.post({ method: 'Fetch.requestPaused', params: { requestId: 'first', request: { url: root } } });
        return;
      }
      if (/^Fetch\.(continue|fail)Request$/.test(message.method)) decisions.push([message.method, message.params.requestId]);
      if (message.method === 'Fetch.continueRequest') {
        this.post({ method: 'Fetch.requestPaused', params: { requestId: 'redirect', request: { url: 'https://copy.example.net/chapter/1' } } });
      }
      if (message.method === 'Fetch.failRequest') this.post({ id: this.navigation, result: { errorText: 'net::ERR_BLOCKED_BY_CLIENT' } });
      this.post({ id: message.id, result: {} });
    }

    close() {
      this.dispatchEvent(new Event('close'));
    }
  };

  const controller = new AbortController();
  const tab = await openCdpTab({ signal: controller.signal, allowDocumentUrl: allow });
  assert.deepEqual(await tab.open(root), { blockedDocument: 'https://copy.example.net/chapter/1' });
  assert.deepEqual(decisions, [['Fetch.continueRequest', 'first'], ['Fetch.failRequest', 'redirect']]);
  assert.deepEqual(closed, []);
  controller.abort();
  await tab.close();
  assert.deepEqual(closed, ['/json/close/owned']);
});
