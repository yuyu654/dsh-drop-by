// hostllm.test.mjs —— 插件用宿主模型生成这一条路。全部用假 ctx，不联网、不出进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHostLlm } from '../src/hostllm.js';

/** 假 ctx：get 按名字返回服务，别的什么都不做。 */
function ctxWith(services) {
  return { get: (k) => services[k] ?? null };
}

/** 假 llm：stream 按 chunk 数组吐。 */
function fakeLlm(chunks, spy = () => {}) {
  return {
    stream(args) {
      spy(args);
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

test('hostllm：没有 llm 服务 → ready=false，不抛', () => {
  const h = makeHostLlm(ctxWith({}));
  assert.equal(h.ready, false);
  assert.equal(h.reason, 'HOST_LLM_MISSING');
  assert.equal(h.generate, undefined);
});

test('hostllm：有 llm 但拿不到模型 → HOST_LLM_NO_MODEL', () => {
  const h = makeHostLlm(ctxWith({ llm: fakeLlm([]), agentDefaultModel: { currentSelection: () => null } }));
  assert.equal(h.ready, false);
  assert.equal(h.reason, 'HOST_LLM_NO_MODEL');
});

test('hostllm：把 text-delta 拼起来，provider/model 用宿主默认', async () => {
  let seen = null;
  const h = makeHostLlm(
    ctxWith({
      llm: fakeLlm(
        [
          { type: 'text-delta', text: '睡了六个半' },
          { type: 'text-delta', text: '小时还困成这样。' },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        (a) => {
          seen = a;
        }
      ),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    }),
    { cfg: { content: { llm: {} } } }
  );

  assert.equal(h.ready, true);
  assert.equal(h.provider, 'deepseek-account');
  assert.equal(h.model, 'deepseek-flash');

  const r = await h.generate({ prompt: '写一句话' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '睡了六个半小时还困成这样。');
  assert.equal(r.via, 'host');
  assert.equal(r.model, 'deepseek-flash');
  // messages 必须是宿主认得的 user 消息形状（id/role/content/source）
  assert.equal(seen.messages[0].role, 'user');
  assert.equal(seen.messages[0].content[0].type, 'text');
  assert.match(seen.messages[0].id, /[0-9a-f-]{8,}/);
  assert.equal(seen.messages[0].source.plugin, 'dsh-drop-by');
});

test('hostllm：配置里指定了 provider/model 就盖过宿主默认', async () => {
  let seen = null;
  const h = makeHostLlm(
    ctxWith({
      llm: fakeLlm([{ type: 'text-delta', text: '嗯。' }], (a) => (seen = a)),
      agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) },
    }),
    { cfg: { content: { llm: { provider: 'p2', model: 'm2' } } } }
  );
  await h.generate({ prompt: 'hi' });
  assert.equal(seen.provider, 'p2');
  assert.equal(seen.model, 'm2');
});

test('hostllm：模型报错（finish.reason.kind=error）→ ok=false', async () => {
  const h = makeHostLlm(
    ctxWith({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }]),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
  );
  const r = await h.generate({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_ERROR');
  assert.match(r.note, /quota/);
});

test('hostllm：流里一个字都没有 → HOST_LLM_EMPTY', async () => {
  const h = makeHostLlm(
    ctxWith({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
  );
  const r = await h.generate({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_EMPTY');
});

test('hostllm：stream 抛异常 → 兜住，不往上冒', async () => {
  const h = makeHostLlm(
    ctxWith({
      llm: {
        stream() {
          throw new Error('boom');
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
  );
  const r = await h.generate({ prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_ERROR');
  assert.match(r.note, /boom/);
});

/** 按第几次调用给不同 chunk 的假 llm，用来测重试。 */
function seqLlm(list) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    stream() {
      const chunks = list[Math.min(calls, list.length - 1)];
      calls += 1;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

test('hostllm：报错一次后重试，第二次成功就照常用（2026-11-09 17:24 那种）', async () => {
  const llm = seqLlm([
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }],
    [{ type: 'text-delta', text: '好了。' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]);
  const h = makeHostLlm(ctxWith({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }));
  const r = await h.generate({ prompt: 'x' });
  assert.equal(llm.calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.text, '好了。');
});

test('hostllm：空文本也会重试，两次都空才判 EMPTY', async () => {
  const llm = seqLlm([[{ type: 'finish', reason: { kind: 'stop' } }]]);
  const h = makeHostLlm(ctxWith({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }));
  const r = await h.generate({ prompt: 'x' });
  assert.equal(llm.calls, 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_EMPTY');
});

test('hostllm：重试次数可配，retries=0 时失败就停', async () => {
  const llm = seqLlm([[{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }]]);
  const h = makeHostLlm(
    ctxWith({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }),
    { cfg: { content: { llm: { retries: 0 } } } }
  );
  const r = await h.generate({ prompt: 'x' });
  assert.equal(llm.calls, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_ERROR');
});

test('video observation passes storyboard image attachments to the host user message', async () => {
  let seen;
  const ref = { attachmentId: 'storyboard-1' };
  const llm = fakeLlm([{ type: 'text-delta', text: '最后一幕切到一只猫。' }], (args) => { seen = args; });
  llm.resolveModelInfo = async (provider, model) => {
    assert.equal(provider, 'vp');
    assert.equal(model, 'vm');
    return { inputModalities: ['text', 'image'] };
  };
  const h = makeHostLlm(ctxWith({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }), { cfg: { content: { forward: { visionProvider: 'vp', visionModel: 'vm' } } } });
  const r = await h.observeVideo({ prompt: '按时间观察', images: [ref] });
  assert.equal(r.ok, true);
  assert.equal(seen.provider, 'vp');
  assert.equal(seen.model, 'vm');
  assert.deepEqual(seen.messages[0].content, [
    { type: 'text', text: '按时间观察' },
    { type: 'image', attachment: ref },
  ]);
});

test('text-only host models never get labeled as a visual observation', async () => {
  let called = false;
  const llm = fakeLlm([{ type: 'text-delta', text: '我猜是猫。' }], () => { called = true; });
  llm.resolveModelInfo = async () => ({ inputModalities: ['text'] });
  const h = makeHostLlm(ctxWith({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'text-only' }) },
  }));
  const r = await h.observeVideo({ prompt: '请看图', images: [{ attachmentId: 'unused' }] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'VIDEO_MODEL_NO_IMAGE');
  assert.equal(called, false);
});

test('hostllm：思考耗尽 maxTokens 返回空时，诊断 note 保留细节且重试翻倍预算', async () => {
  const seenMax = [];
  const logs = [];
  let calls = 0;
  const h = makeHostLlm(
    ctxWith({
      llm: {
        stream(args) {
          seenMax.push(args.maxTokens);
          calls += 1;
          return (async function* () {
            if (calls === 1) {
              yield { type: 'reasoning-delta', text: '正在推导' };
              yield { type: 'usage', usage: { outputTokens: 1024 } };
              yield { type: 'finish', reason: { kind: 'max-tokens' } };
              return;
            }
            yield { type: 'text-delta', text: '行。' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'ali', model: 'deepseek-v4.1-flash-1017' }) },
    }),
    { cfg: { content: { llm: {} } }, log: (m) => logs.push(m) }
  );
  const okRes = await h.generate({ prompt: '说一句', minOutputTokens: 1024 });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.text, '行。');
  assert.deepEqual(seenMax, [1024, 2048]);
  assert.match(logs[0], /finish=max-tokens.*reasoning=4字.*outTokens=1024.*maxTokens=1024/);

  const emptyH = makeHostLlm(
    ctxWith({
      llm: fakeLlm([
        { type: 'reasoning-delta', text: '太长了' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]),
      agentDefaultModel: { currentSelection: () => ({ provider: 'ali', model: 'deepseek-v4.1-flash-1017' }) },
    }),
    { cfg: { content: { llm: { retries: 0 } } }, log: (m) => logs.push(m) }
  );
  const failRes = await emptyH.generate({ prompt: '说一句', minOutputTokens: 768 });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.reason, 'HOST_LLM_EMPTY');
  assert.match(failRes.note, /finish=max-tokens · reasoning=3字 · maxTokens=1024/);
  assert.match(logs.at(-1), /生成最终失败（HOST_LLM_EMPTY：finish=max-tokens/);
});
