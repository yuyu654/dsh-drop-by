import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEmotionInbox,
  compactEmotionInbox,
  formatExplorationMoodText,
  inspectEmotionPlugin,
  readPortraitMoodMap,
  recordExplorationEmotion,
  repairEmotionConfig,
} from '../src/decision/emotion-sync.js';

function makeEnv(t, { profile = 'desktop', withConfig = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-emotion-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const profDir = path.join(home, 'profiles', profile);
  const pluginDir = path.join(profDir, 'node_modules', 'emotion-state-portrait');
  const emotionDir = path.join(pluginDir, 'emotion');
  fs.mkdirSync(emotionDir, { recursive: true });

  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'emotion-state-portrait', version: '1.0.5' }));
  fs.writeFileSync(path.join(pluginDir, 'qq-emotion.mjs'), 'export default {};');

  fs.writeFileSync(path.join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-ds-test',
    '  ALI_API_KEY: sk-ali-local-test',
  ].join('\n'));

  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: ali',
    '    model: deepseek-v4.1-flash-1017',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      ali:',
    '        apiKeyEnv: ALI_API_KEY',
    '        baseURL: https://example-maas.local/compatible-mode/v1',
    '        models:',
    '          - id: deepseek-v4.1-flash-1017',
  ].join('\n'));

  const authorConfig = {
    owner: { qq: '3425023826' },
    llm: {
      api: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
      model: 'qwen3.6-flash',
      apiKeyEnv: 'EMOTION_LLM_KEY',
      keyFile: 'C:/Users/YangXinYuan/.dsh/.credentials.yaml',
      keyPattern: 'QWEN_TOKEN_PLAN_CN_API_KEY:\\s*(\\S+)',
    },
    integration: {
      source: 'onebot',
      personaBlock: {
        enabled: false,
        file: 'C:/Users/YangXinYuan/.dsh/profiles/desktop/cordis.patch.yml',
      },
    },
  };
  fs.writeFileSync(path.join(emotionDir, 'config.example.json'), JSON.stringify(authorConfig, null, 2));
  if (withConfig) fs.writeFileSync(path.join(emotionDir, 'config.json'), JSON.stringify(authorConfig, null, 2));
  return { home, profDir, pluginDir, emotionDir };
}

test('repairEmotionConfig fixes author paths, credentials, LLM provider, and owner.qq dynamically for any profile', (t) => {
  const { home, pluginDir, emotionDir } = makeEnv(t, { profile: 'custom-profile', withConfig: true });
  const cfg = { channels: { qq: { peerId: '728361417' } } };

  const before = inspectEmotionPlugin({ dshHome: home, cfg, env: {} });
  assert.equal(before.needsRepair, true);
  assert.ok(before.issues.length >= 4);

  const res = repairEmotionConfig({ dshHome: home, cfg, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(fs.existsSync(path.join(emotionDir, 'config.json.bak-before-local')), true);

  const written = JSON.parse(fs.readFileSync(path.join(emotionDir, 'config.json'), 'utf8'));
  assert.equal(written.llm.keyFile, path.join(home, '.credentials.yaml').replace(/\\/g, '/'));
  assert.equal(written.llm.api, 'https://example-maas.local/compatible-mode/v1');
  assert.equal(written.llm.model, 'deepseek-v4.1-flash-1017');
  assert.equal(written.llm.apiKeyEnv, 'ALI_API_KEY');
  assert.equal(written.llm.keyPattern, 'ALI_API_KEY:\\s*(\\S+)');
  assert.equal(written.integration.personaBlock.file, path.join(home, 'profiles', 'custom-profile', 'cordis.patch.yml').replace(/\\/g, '/'));
  assert.equal(written.integration.source, 'file');
  assert.equal(written.integration.fileInbox, 'emotion/inbox.jsonl');
  assert.equal(written.owner.qq, '728361417');

  assert.equal(res.inspection.needsRepair, false, 'after repair there should be no remaining issues');

  const second = repairEmotionConfig({ dshHome: home, cfg, env: {} });
  assert.equal(second.changed, false, 'repair should be idempotent');
  assert.ok(pluginDir);
});

test('repairEmotionConfig seeds emotion/config.json from config.example.json on a fresh machine', (t) => {
  const { home, emotionDir } = makeEnv(t, { withConfig: false });
  const cfg = { channels: { qq: { peerId: '998877' } } };
  const res = repairEmotionConfig({ dshHome: home, cfg, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(fs.existsSync(path.join(emotionDir, 'config.json')), true);
  assert.equal(res.inspection.needsRepair, false);
});

test('appendEmotionInbox writes deduplicated chat turns and readPortraitMoodMap strips rule suffix', (t) => {
  const { home, pluginDir, emotionDir } = makeEnv(t, { withConfig: true });
  const first = appendEmotionInbox({ dshHome: home, env: {}, user: '728361417', role: 'user', text: '早啊', t: 1000 });
  const dup = appendEmotionInbox({ dshHome: home, env: {}, user: '728361417', role: 'user', text: '早啊', t: 2000 });
  const reply = appendEmotionInbox({ dshHome: home, env: {}, user: '728361417', role: 'ai', text: '早，刚醒', t: 3000 });
  assert.equal(first, true);
  assert.equal(dup, false);
  assert.equal(reply, true);

  const lines = fs.readFileSync(path.join(emotionDir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.role, l.text]), [['user', '早啊'], ['ai', '早，刚醒']]);

  fs.writeFileSync(path.join(emotionDir, 'state.json'), JSON.stringify({ updatedAt: Date.now() }));
  fs.writeFileSync(path.join(pluginDir, 'mood-map.json'), JSON.stringify({
    '728361417': '心情：欣喜Lv1（语气轻快）；对她：熟悉；硬规则：不要照着说',
    default: '心情：平静',
  }));
  assert.equal(readPortraitMoodMap({ dshHome: home, env: {}, peer: '728361417' }), '心情：欣喜Lv1（语气轻快）；对她：熟悉');
});

test('recordExplorationEmotion formats research/leisure runs into emotion/inbox.jsonl when enabled', (t) => {
  const { home, emotionDir } = makeEnv(t, { withConfig: true });
  const researchState = {
    lastAt: 5000,
    lastRun: { mode: 'research' },
    thread: { topic: '本地声卡驱动', progress: '排查了采样率', discovery: '48kHz 下爆音消失' },
    candidate: { line: '原来是采样率打架了' },
    mood: { text: '松了口气，还有点得意' },
  };
  const leisureState = {
    lastAt: 6000,
    lastRun: { mode: 'leisure' },
    leisure: { topic: '深夜翻老漫画', discovery: '重看第三卷还是觉得分镜很绝' },
    mood: { text: '安静又有点怀旧' },
  };

  // exploration.portrait 与 exploration.mood 都关闭时不写入
  const skipped = recordExplorationEmotion({
    dshHome: home,
    env: {},
    cfg: { channels: { qq: { peerId: '728361417' } }, exploration: { portrait: false, mood: false } },
    state: researchState,
  });
  assert.equal(skipped, '');
  assert.equal(fs.existsSync(path.join(emotionDir, 'inbox.jsonl')), false);

  // 开启 exploration.mood（或 portrait）时分别记录研究与休闲成果
  const rText = recordExplorationEmotion({
    dshHome: home,
    env: {},
    cfg: { channels: { qq: { peerId: '728361417' } }, exploration: { portrait: false, mood: true } },
    state: researchState,
  });
  const lText = recordExplorationEmotion({
    dshHome: home,
    env: {},
    cfg: { channels: { qq: { peerId: '728361417' } }, exploration: { portrait: true, mood: false } },
    state: leisureState,
  });
  assert.match(rText, /^\[自主探索·研究\]/);
  assert.match(lText, /^\[自主探索·休闲\]/);
  assert.equal(formatExplorationMoodText({}), '');

  const entries = fs.readFileSync(path.join(emotionDir, 'inbox.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.user, e.role, e.name, e.t]), [
    ['728361417', 'ai', '自主探索', 5000],
    ['728361417', 'ai', '自主探索', 6000],
  ]);
  assert.match(entries[0].text, /48kHz 下爆音消失/);
  assert.match(entries[1].text, /分镜很绝/);
});

test('compactEmotionInbox archives consumed prefix, keeps unread tail, and resets inboxOffset', (t) => {
  const { home, emotionDir } = makeEnv(t, { withConfig: true });
  const inboxPath = path.join(emotionDir, 'inbox.jsonl');
  const firstLine = `${JSON.stringify({ user: '728361417', role: 'user', text: '旧消息一'.repeat(20), t: 1000 })}\n`;
  const secondLine = `${JSON.stringify({ user: '728361417', role: 'ai', text: '未消费新消息', t: 2000 })}\n`;
  fs.writeFileSync(inboxPath, firstLine + secondLine, 'utf8');
  const consumedBytes = Buffer.byteLength(firstLine, 'utf8');
  fs.writeFileSync(path.join(emotionDir, 'state.json'), JSON.stringify({
    schema: 'xiaojing-emotion/v1',
    inboxOffset: consumedBytes,
    updatedAt: Date.now(),
  }));

  const res = compactEmotionInbox({ dshHome: home, env: {}, maxBytes: 50 });
  assert.equal(res.ok, true);
  assert.equal(res.compacted, true);
  assert.equal(res.archivedBytes, consumedBytes);
  assert.equal(fs.readFileSync(inboxPath, 'utf8'), secondLine);
  assert.equal(fs.readFileSync(path.join(emotionDir, 'inbox.archive.jsonl'), 'utf8'), firstLine);
  const updatedState = JSON.parse(fs.readFileSync(path.join(emotionDir, 'state.json'), 'utf8'));
  assert.equal(updatedState.inboxOffset, 0);

  const inspected = inspectEmotionPlugin({ dshHome: home, env: {} });
  assert.equal(inspected.stateExists, true);
  assert.equal(inspected.inboxExists, true);
  assert.equal(inspected.inboxBytes, Buffer.byteLength(secondLine, 'utf8'));
});
