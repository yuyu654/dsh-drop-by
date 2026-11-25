import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_FIELDS,
  applyPresetToConfig,
  updatePresetOverride,
  resetPresetOverride,
  presetsForUi,
} from '../src/presets.js';
import { applyChange } from '../src/settings.js';
import { loadConfig } from '../src/config.js';

test('presets：默认是 custom；切到套餐前自动快照原参数，切回 custom 完整恢复', () => {
  const base = loadConfig();
  base.dryRun = false;
  base.send.enabled = true;
  base.quietHours = [['23:00', '07:00']];
  base.exploration.interest = '《哆哆嗦嗦逃离你》';
  base.rules.dailyCap = 9;
  base.rules.minGapMin = 150;
  base.presets = { active: 'custom', customSnapshot: null, overrides: {} };

  assert.equal(presetsForUi(base).active, 'custom');

  // 1. 切到「安静克制」：应用套餐值，不碰安全闸与个人兴趣，同时快照原参数
  const r1 = applyPresetToConfig(base, 'quiet');
  assert.equal(r1.ok, true);
  assert.equal(r1.active, 'quiet');
  assert.equal(r1.cfg.rules.dailyCap, 2);
  assert.equal(r1.cfg.rules.minGapMin, 360);
  assert.equal(r1.cfg.dryRun, false);
  assert.equal(r1.cfg.send.enabled, true);
  assert.deepEqual(r1.cfg.quietHours, [['23:00', '07:00']]);
  assert.equal(r1.cfg.exploration.interest, '《哆哆嗦嗦逃离你》');
  assert.equal(r1.cfg.presets.customSnapshot['rules.dailyCap'], 9);

  // 2. 再切到「粘人热聊」：customSnapshot 仍保留最初的 9 和 150
  const r2 = applyPresetToConfig(r1.cfg, 'clingy');
  assert.equal(r2.ok, true);
  assert.equal(r2.cfg.rules.dailyCap, 8);
  assert.equal(r2.cfg.rules.qqContinuation, true);
  assert.equal(r2.cfg.presets.customSnapshot['rules.dailyCap'], 9);

  // 3. 切回「自定义」：精准恢复最初的 9 和 150
  const r3 = applyPresetToConfig(r2.cfg, 'custom');
  assert.equal(r3.ok, true);
  assert.equal(r3.restored, true);
  assert.equal(r3.cfg.presets.active, 'custom');
  assert.equal(r3.cfg.rules.dailyCap, 9);
  assert.equal(r3.cfg.rules.minGapMin, 150);
});

test('presets：在设置页手动修改套餐管辖参数后生效，且模式自动切回 custom；改非套餐参数不影响当前套餐', () => {
  const base = loadConfig();
  const r1 = applyPresetToConfig(base, 'daily');
  assert.equal(r1.cfg.presets.active, 'daily');

  // 改非套餐参数（tickMinutes）→ 保持 daily
  const nonPreset = applyChange(r1.cfg, 'tickMinutes', 15);
  assert.equal(nonPreset.ok, true);
  assert.equal(nonPreset.cfg.tickMinutes, 15);
  assert.equal(nonPreset.cfg.presets.active, 'daily');

  // 手动改套餐管辖参数（rules.dailyCap）→ 生效且自动变为 custom
  const manual = applyChange(nonPreset.cfg, 'rules.dailyCap', 7);
  assert.equal(manual.ok, true);
  assert.equal(manual.cfg.rules.dailyCap, 7);
  assert.equal(manual.cfg.presets.active, 'custom');
  assert.equal(manual.cfg.presets.customSnapshot['rules.dailyCap'], 7);
});

test('presets：高级里修改当前激活套餐参数时同步立即生效（选项 A）；改未激活套餐不影响当前配置', () => {
  const base = loadConfig();
  const r1 = applyPresetToConfig(base, 'daily');
  assert.equal(r1.cfg.rules.dailyCap, 4);

  // 修改当前激活的 daily 套餐的每日上限 → 同步立即生效且仍保持 daily 激活
  const ov1 = updatePresetOverride(r1.cfg, 'daily', 'rules.dailyCap', 6);
  assert.equal(ov1.ok, true);
  assert.equal(ov1.syncedLive, true);
  assert.equal(ov1.cfg.presets.active, 'daily');
  assert.equal(ov1.cfg.rules.dailyCap, 6);
  assert.equal(presetsForUi(ov1.cfg).presets.find((p) => p.id === 'daily').customized, true);

  // 修改未激活的 quiet 套餐 → 不影响当前配置，只存模板
  const ov2 = updatePresetOverride(ov1.cfg, 'quiet', 'rules.dailyCap', 3);
  assert.equal(ov2.ok, true);
  assert.equal(ov2.syncedLive, false);
  assert.equal(ov2.cfg.rules.dailyCap, 6);
  assert.equal(presetsForUi(ov2.cfg).presets.find((p) => p.id === 'quiet').values['rules.dailyCap'], 3);

  // 恢复当前激活的 daily 套餐默认 → 同步回到 4
  const reset = resetPresetOverride(ov2.cfg, 'daily');
  assert.equal(reset.ok, true);
  assert.equal(reset.syncedLive, true);
  assert.equal(reset.cfg.rules.dailyCap, 4);
  assert.equal(presetsForUi(reset.cfg).presets.find((p) => p.id === 'daily').customized, false);
});

test('presets：所有数值型套餐参数均声明单位且做范围校验', () => {
  for (const f of PRESET_FIELDS) {
    if (f.type === 'int' || f.type === 'num') {
      assert.ok(typeof f.unit === 'string' && f.unit.length > 0, `missing unit for ${f.path}`);
    }
  }
  const bad = updatePresetOverride(loadConfig(), 'daily', 'rules.dailyCap', 999);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /条/);
});

test('presets：旧版 exploration.leisureEvery 切到套餐再切回自定义时完整恢复', () => {
  const legacyCfg = loadConfig();
  delete legacyCfg.exploration.bias;
  legacyCfg.exploration.leisureEvery = 1;

  const toDaily = applyPresetToConfig(legacyCfg, 'daily');
  assert.equal(toDaily.ok, true);
  assert.equal(toDaily.cfg.exploration.bias, 'balanced');
  assert.equal(Object.hasOwn(toDaily.cfg.exploration, 'leisureEvery'), false);

  const back = applyPresetToConfig(toDaily.cfg, 'custom');
  assert.equal(back.ok, true);
  assert.equal(back.restored, true);
  assert.equal(back.cfg.exploration.leisureEvery, 1);
  assert.equal(Object.hasOwn(back.cfg.exploration, 'bias'), false);
});
