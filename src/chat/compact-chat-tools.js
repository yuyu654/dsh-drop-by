// Apply the filter to the bound agent's tools only. Host-side lookups can still use every tool.
const OPTIONAL_CHAT_TOOLS = [
  'acp_cache', 'acp_read_original_image', 'unlag_refresh',
  'cache_search', 'free_search_test', 'multi_search', 'research', 'weather',
  'video_help', 'video_locate', 'video_search', 'video_storyboard_settings', 'video_subtitles', 'video_zoom',
  'create_goal', 'create_skill', 'exit_plan_mode', 'get_goal', 'interrupt_agent',
  'list_agents', 'update_goal', 'workflow',
];

export function createCompactChatTools({ getConfig, getSessionId, getHost, getTools, warn }) {
  let active = null;
  let status = { state: 'off', hiddenCount: 0 };
  let syncing = false;
  let stopped = false;
  let lastError = '';

  function release() {
    const previous = active;
    active = null;
    previous?.dispose();
  }

  function sync({ refresh = false, disposing } = {}) {
    if (syncing || stopped) return;
    // Applying or releasing a scope itself emits tools/change synchronously.
    syncing = true;
    try {
      const cfg = getConfig();
      const off = !cfg || cfg.enabled === false || cfg.rules?.compactChatTools !== true;
      const host = off ? null : getHost();
      const supported = typeof host?.agents?.get === 'function' &&
        typeof host?.tools?.restrict === 'function' && typeof host.tools.schemas === 'function';
      const sessionId = supported ? getSessionId(cfg) : '';
      let agent = sessionId ? host.agents.get(sessionId) : null;
      if (agent === disposing) agent = null;
      if (active && active.agent === agent && !refresh) return;

      release();
      const tools = agent ? getTools(agent) : null;
      if (off) status = { state: 'off', hiddenCount: 0 };
      else if (!supported || (agent && (typeof tools?.restrict !== 'function' || typeof tools.schemas !== 'function'))) {
        status = { state: 'unsupported', hiddenCount: 0 };
      } else if (!sessionId) status = { state: 'unbound', hiddenCount: 0 };
      else if (!agent) status = { state: 'waiting', hiddenCount: 0 };
      else {
        const visibleNames = new Set(tools.schemas(agent).map(({ name }) => name));
        let deny = OPTIONAL_CHAT_TOOLS.filter(name => visibleNames.has(name));
        let dispose = () => {};
        for (let attempt = 0; attempt < 8 && deny.length; attempt += 1) {
          try {
            dispose = tools.restrict({ deny });
            break;
          } catch (err) {
            const m = /unknown global tool\s+"([^"]+)"/i.exec(String(err?.message || err));
            if (!m || !deny.includes(m[1])) throw err;
            deny = deny.filter((name) => name !== m[1]);
          }
        }
        active = { agent, dispose };
        const retained = new Set(tools.schemas(agent).map(({ name }) => name));
        status = { state: 'active', hiddenCount: deny.filter(name => !retained.has(name)).length };
      }
      lastError = '';
    } catch (error) {
      status = { state: 'error', hiddenCount: 0 };
      try { release(); } catch { /* A host cleanup failure must never block chatting. */ }
      const message = String(error?.message || error).slice(0, 200);
      if (message !== lastError) warn('精简陪聊工具未生效：' + message);
      lastError = message;
    } finally {
      syncing = false;
    }
  }

  return {
    sync,
    status: () => status,
    stop() {
      stopped = true;
      try { release(); } catch (error) {
        warn('恢复陪聊工具失败：' + String(error?.message || error).slice(0, 160));
      }
      status = { state: 'off', hiddenCount: 0 };
    },
  };
}

