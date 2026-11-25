import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

test('nextTopic pins one round and auto-clears; explicit body.topic overrides; offPeakOnly exposes live peakStatus', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-topic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.PG_STATE_PATH = path.join(dir, 'state.json');
  process.env.PG_DSH_HOME = dir;
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢科普与天文。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [],
    dryRun: true,
    exploration: { web: false, leisureEvery: 1, offPeakOnly: true, nextTopic: '韦伯望远镜最新观测' },
    persona: { localFile: personaFile, dshHome: dir },
  }));

  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-05-01T08:00:00+08:00') });

  const { apply } = await import('../src/plugin.js');
  const { loadConfig } = await import('../src/settings/config.js');
  let route;
  const services = {
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'text' }) },
    llm: { async *stream({ messages }) {
      const prompt = messages[0].content[0].text;
      if (prompt.includes('韦伯望远镜最新观测')) {
        yield {
          type: 'text-delta',
          text: JSON.stringify({ action: 'start', topic: '韦伯望远镜最新观测', progress: '整理了巡天思路', next: '看系外行星光谱' }),
        };
      } else {
        yield {
          type: 'text-delta',
          text: JSON.stringify({ action: 'start', topic: '临时指定研究题', progress: '完成一轮推导', next: '继续对比样本' }),
        };
      }
    } },
  };
  const api = apply({ get: (k) => services[k], effect: (f) => f() }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  assert.equal(api.snapshot().exploration.offPeakOnly, true);
  assert.equal(typeof api.snapshot().exploration.peakStatus?.offPeak, 'boolean');

  let res1;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
    setHeader() {}, end(s) { res1 = JSON.parse(s); },
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.state.exploration.thread.topic, '韦伯望远镜最新观测');
  assert.equal(res1.state.exploration.nextTopic, '');
  assert.equal(loadConfig().exploration.nextTopic, '');

  let res2;
  const bodyStream = Readable.from([Buffer.from(JSON.stringify({ topic: '临时指定研究题' }))]);
  bodyStream.url = '/api/dsh-drop-by/explore';
  bodyStream.method = 'POST';
  await route.handler(bodyStream, {
    setHeader() {}, end(s) { res2 = JSON.parse(s); },
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.state.exploration.thread.topic, '临时指定研究题');

  // 验证自动探索受 offPeakOnly 控制：工作日高峰跳过，周中节假日与周末调休均可自动运行
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [],
    dryRun: true,
    exploration: { auto: true, web: false, intervalMinutes: 30, leisureEvery: 1, offPeakOnly: true },
    persona: { localFile: personaFile, dshHome: dir },
  }));
  t.mock.timers.setTime(Date.parse('2026-05-01T10:00:00+08:00')); // 周五劳动节法定节假日 -> 谷时放行
  const holidayRes = await api.runExploration();
  assert.equal(holidayRes.ok, true);

  t.mock.timers.setTime(Date.parse('2026-10-10T10:00:00+08:00')); // 周六调休上班日 -> 按 DS 规则仍算谷时放行
  const weekendWorkRes = await api.runExploration();
  assert.equal(weekendWorkRes.ok, true);

  t.mock.timers.setTime(Date.parse('2026-11-16T10:00:00+08:00')); // 普通周一 10:00 高峰 -> 自动跳过
  const peakRes = await api.runExploration();
  assert.deepEqual(peakRes, { ok: false, reason: 'PEAK_HOURS' });

  t.mock.timers.setTime(Date.parse('2026-11-16T23:00:00+08:00'));
  assert.deepEqual(await api.runExploration(), { ok: false, reason: 'CHARACTER_ASLEEP' });
  assert.equal(api.snapshot().exploration.pausedForRest, true);
  let manualAtNight;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
    setHeader() {}, end(body) { manualAtNight = JSON.parse(body); },
  });
  assert.equal(manualAtNight.ok, true);
});
