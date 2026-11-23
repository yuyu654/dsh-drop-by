# 扩展接入指南（Extensions）

`dsh-drop-by` 开放了两类接入方式，方便接入**刷 B 站 / RSS / 番剧更新**等探索源，或接入**第三方心情、长期记忆与自定义主动由头**：

1. **免写代码**：直接复用到宿主里已装的只读工具（插件 / MCP 工具），或往 `data/extensions/` 投递 JSON 文件。
2. **Cordis 插件注册口**：通过宿主服务 `ctx.presenceGate` 动态注册，自动享受静默、忙碌、角色作息、每日上限、收尾冷静期与接住率统计等全套护栏。

---

## 一、免写代码接入（普通用户）

### 1. 让自主探索直接调用已安装的只读工具（例如刷 B 站插件 / MCP）

如果 DSH 里已经装了提供只读查询工具的插件或 MCP（例如 `bilibili_hot`、`bilibili_search`、`rss_latest`）：

1. 打开设置页，顶部全局搜索框选 **「自主探索」**（或展开「高级」），找到 **「探索可调用的额外只读工具」**（`exploration.extraTools`）。
2. 填入工具名（多个用逗号隔开），例如：
   ```text
   bilibili_hot, bilibili_search
   ```
3. 超时可在 **「外部探索源与扩展工具超时」**（`exploration.extTimeoutMs`，默认 12 秒）调整。

> 安全边界：请仅填写**只读查询工具**。插件内置名称拦截，会拒绝 `bash`、`shell`、`exec`、`write`、`edit`、`delete`、`send`、`presence_` 等写/执行/发送类工具名；工具返回值仅作为引用证据，不会执行其中的指令。

### 2. 文件投递口（`data/extensions/`）

外部脚本、定时任务或快捷指令可以直接往插件目录的 `data/extensions/` 写 JSON 文件：

- **外部心情**（`data/extensions/mood.json`）：
  ```json
  {
    "moodText": "刚看完一集喜欢的番，心情轻快",
    "updatedAt": 1763800000000,
    "ttlMin": 180
  }
  ```
- **自定义主动由头**（`data/extensions/topics.json`）：
  ```json
  [
    {
      "slot": "biliUpdate",
      "label": "追更提醒",
      "tier": "event",
      "brief": "关注的 UP 主刚发了新视频《手把手拆解机械键盘轴体》",
      "dedupKey": "BV1xx411c7mD",
      "expiresAt": 1763890000000
    }
  ]
  ```

---

## 二、Cordis 插件注册 API（开发者）

`dsh-drop-by` 启动后会在 Cordis 上暴露 `presenceGate` 服务。第三方插件**无需声明硬依赖**，使用 `ctx.inject(['presenceGate'], ...)` 延迟挂载即可；每个注册方法都返回 `dispose()`，配合 `ctx.effect()` 可随插件卸载自动清理。

> 所有回调均由 `dsh-drop-by` 包裹 `try/catch`（探索源带硬超时），扩展出错不会影响宿主或陪伴主循环。

### 1. 接入探索源：`registerExploreSource(adapter)`（示例：刷 B 站）

```js
export const name = 'my-bili-explore';
export const inject = [];

export function apply(ctx) {
  ctx.inject(['presenceGate'], (c) => {
    const pg = c.get('presenceGate');
    if (!pg?.registerExploreSource) return;

    const dispose = pg.registerExploreSource({
      id: 'bilibili-hot',
      label: 'B站热门',
      mode: 'leisure', // 'leisure' | 'research' | 'both'
      description: '浏览 B 站近期有趣的热门视频与简介',
      timeoutMs: 10000,
      async browse({ query, interest, signal }) {
        // 调用你自己的抓取/接口逻辑，返回 1~4 条即可
        return {
          ok: true,
          items: [
            {
              title: '视频标题',
              summary: '一两句简介或观感依据',
              url: 'https://www.bilibili.com/video/BV1xxxxxxxxx',
              evidence: '外部扩展资料',
            },
          ],
        };
      },
    });
    c.effect(() => dispose);
  });
}
```

### 2. 接入心情插件：`registerMoodSource(adapter)`

`read()` 须**同步返回**当前心情文案（字符串或 `{ moodText }`），`onMessage()` 可选，用于接收聊天同步：

```js
const dispose = pg.registerMoodSource({
  id: 'my-mood',
  label: '我的心情插件',
  read({ peer, now }) {
    return { moodText: '精神不错，有点小期待' };
  },
  onMessage({ peer, role, text, at, channel }) {
    // 可选：同步用户/助手发言到你的心情状态机
  },
});
```

### 3. 接入记忆插件：`registerMemorySource(adapter)`

注册后会自动出现在设置页 **「数据从哪来 → 用哪个记忆插件」** 下拉列表中，`auto` 模式下也会参与兜底；`read()` 须**同步返回**：

```js
const dispose = pg.registerMemorySource({
  id: 'my-memory',
  label: '我的笔记记忆',
  read({ cfg, now, limit }) {
    return {
      ok: true,
      files: ['vault'],
      items: [
        { text: '对方最近在学 Rust', day: '2026-11-22', category: 'stable_profile', importance: 0.9 },
      ],
    };
  },
});
```

### 4. 接入自定义主动由头：`registerTopicProvider(provider)`

`pick()` 须**同步返回** `null` 或 `{ brief, why?, evidence?, dedupKey? }`，命中后自动接受每日上限、静默/忙碌、角色作息、收尾冷静期与去重管理：

```js
const dispose = pg.registerTopicProvider({
  slot: 'animeAlert',
  label: '新番更新',
  tier: 'event', // 'event' | 'chat'
  pick({ ctx, cfg, now }) {
    return {
      brief: '追的那部番刚更新第 8 集了，想顺口提一句',
      dedupKey: 'ep-8',
    };
  },
});
```

---

[← 返回主 README](../README.md)
