/**
 * dsh-qq-digest —— 客户端半（Client）。
 *
 * 以 dsh.client bundle 格式加载：在「设置」里注册一节「QQ 群摘要」，
 * 用它来选哪些群参与总结、多久总结一次、用哪个摘要器。
 *
 * 三条约束：
 *  1) 这个面板只跟宿主半的 /qq-digest-api 说话，不碰 QQ 接口、不发消息。
 *  2) 列表里只有群；私聊连展示位都没有（宿主那边也只回群）。
 *  3) 保存走宿主同一套 config 校验，写坏的配置会被拒，不会落盘。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq-digest',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
  const h = React.createElement;

  const SLOT = 'settings.section';
  const SECTION_ID = 'qq-digest';
  const ORDER = 26;

  /** 子路径部署时（反代挂在 /app/x/ 下）API 也要带同一前缀。 */
  function detectBase() {
    try {
      const scripts = document.querySelectorAll('script[src]');
      for (const el of scripts) {
        const path = new URL(el.src, document.baseURI || location.href).pathname;
        const match = /^(.*?)\/plugins\/[^/]+\/client\.js/.exec(path);
        if (match) return match[1].replace(/\/+$/, '');
      }
    } catch {
      /* 非浏览器环境 */
    }
    return '';
  }

  const BASE = detectBase();
  const API = `${BASE}/qq-digest-api`;

  /**
   * 客户端半的存活心跳：factory 执行 / 注册成功 / 注册失败 各打一次。
   * 宿主把它记进 <dataDir>/client-boot.json 并在 /state 里回显 ——
   * 「设置里看不见」时能立刻分清是「没加载」「加载了没注册」还是「注册了但没显示」。
   */
  function ping(phase, extra) {
    try {
      fetch(`${API}/client-boot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase, page: 'settings', ...(extra || {}) }),
        keepalive: true,
      }).catch(() => {});
    } catch (err) {
      // 心跳失败不影响任何功能
    }
  }

  ping('factory');


  async function apiGet(path) {
    const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── 样式（内联，避免污染全局） ──────────────────────────────────────────

  const S = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13, lineHeight: 1.6 },
    card: {
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
      borderRadius: 10,
      padding: '12px 14px',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
    },
    cardTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
    hint: { color: 'var(--dsw-alias-label-secondary, #8a8a8a)', fontSize: 12, marginTop: 6 },
    row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' },
    grow: { flex: 1, minWidth: 0 },
    mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.65 },
    name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    input: {
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 6,
      padding: '3px 8px',
      color: 'inherit',
      fontSize: 12,
      width: 160,
    },
    btn: {
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      background: 'transparent',
      color: 'inherit',
      borderRadius: 8,
      padding: '5px 14px',
      cursor: 'pointer',
      fontSize: 12,
    },
    btnPrimary: {
      border: '1px solid transparent',
      background: 'var(--dsw-alias-brand-primary, #4c8dff)',
      color: '#fff',
      borderRadius: 8,
      padding: '5px 14px',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 600,
    },
    chip: (on) => ({
      border: `1px solid ${on ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))'}`,
      background: on ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'transparent',
      color: on ? '#fff' : 'inherit',
      borderRadius: 999,
      padding: '2px 10px',
      cursor: 'pointer',
      fontSize: 12,
    }),
    badge: (tone) => ({
      display: 'inline-block',
      borderRadius: 999,
      padding: '1px 8px',
      fontSize: 11,
      border: `1px solid color-mix(in srgb, ${stateToken(tone)} 35%, transparent)`,
      background: `color-mix(in srgb, ${stateToken(tone)} 16%, transparent)`,
      color: stateToken(tone),
    }),
    error: { color: 'var(--dsw-alias-state-error-primary, #d9534f)', fontSize: 12 },
    list: { display: 'flex', flexDirection: 'column', maxHeight: 320, overflowY: 'auto' },
    empty: { padding: '10px 0', color: 'var(--dsw-alias-label-secondary, #8a8a8a)', fontSize: 12 },
    actions: { display: 'flex', gap: 8, alignItems: 'center' },
  };

  /** 状态色一律走主题 token，缺 token 时回退到固定色。 */
  function stateToken(tone) {
    if (tone === 'bad') return 'var(--dsw-alias-state-error-primary, #d9534f)';
    if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary, #c98a1b)';
    return 'var(--dsw-alias-state-success-primary, #3f9c5f)';
  }

  const WEEKDAYS = [
    ['MO', '一'],
    ['TU', '二'],
    ['WE', '三'],
    ['TH', '四'],
    ['FR', '五'],
    ['SA', '六'],
    ['SU', '日'],
  ];

  // ── 面板 ────────────────────────────────────────────────────────────────

  function Panel() {
    const [state, setState] = React.useState(null);
    const [draft, setDraft] = React.useState(null);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [busy, setBusy] = React.useState('');
    const [openDigest, setOpenDigest] = React.useState(null);

    const load = React.useCallback(async () => {
      try {
        const data = await apiGet('/state');
        setState(data);
        setDraft(toDraft(data));
        setError('');
      } catch (err) {
        setError(String(err?.message ?? err));
      }
    }, []);

    React.useEffect(() => {
      load();
    }, [load]);

    if (error && state === null) {
      return h('div', { style: S.wrap }, h('div', { style: S.error }, `读取失败：${error}`));
    }
    if (state === null || draft === null) {
      return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取 QQ 群摘要设置…'));
    }

    const dirty = JSON.stringify(toDraft(state)) !== JSON.stringify(draft);

    function toggleGroup(groupId) {
      setDraft((prev) => {
        const next = { ...prev, groups: { ...prev.groups } };
        const entry = next.groups[groupId] ?? { enabled: true, name: '' };
        next.groups[groupId] = { ...entry, enabled: !entry.enabled };
        return next;
      });
    }

    function renameGroup(groupId, name) {
      setDraft((prev) => {
        const next = { ...prev, groups: { ...prev.groups } };
        const entry = next.groups[groupId] ?? { enabled: true, name: '' };
        next.groups[groupId] = { ...entry, name };
        return next;
      });
    }

    function patchSchedule(patch) {
      setDraft((prev) => ({ ...prev, schedule: { ...prev.schedule, ...patch } }));
    }

    async function save() {
      setNotice('');
      if (duplicateNames.size > 0) {
        setError(`名字重复：${[...duplicateNames].join('、')} —— 请改成不同的名字`);
        return false;
      }
      setBusy('save');
      try {
        const payload = {
          groupsEnabled: draft.groupsEnabled !== false,
          groups: buildGroupsPayload(draft),
          private: buildPrivatePayload(draft),
          summarizer: draft.summarizer,
          schedule: draft.schedule,
        };
        const data = await apiPost('/config', payload);
        setState(data.state);
        setDraft(toDraft(data.state));
        setNotice('已保存');
        return true;
      } catch (err) {
        setError(String(err?.message ?? err));
        return false;
      } finally {
        setBusy('');
      }
    }

    /**
     * 立即总结。options.alsoSave = true 时先落盘再跑。
     *
     * 这样按钮**永远可点**：以前它在「有未保存改动」时是灰的，
     * 表现就是「找不到立即总结的按钮」。
     */
    async function runNow(options) {
      setNotice('');
      setError('');
      if (options && options.alsoSave === true && dirty) {
        const saved = await save();
        if (!saved) return;
      }
      setBusy('run');
      try {
        const data = await apiPost('/run', {});
        const result = data.result ?? {};
        const done = Array.isArray(result.summarized) ? result.summarized.length : 0;
        const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
        const failed = Array.isArray(result.errors) ? result.errors.length : 0;
        setNotice(
          result.status === 'ALREADY_RUNNING'
            ? '已有一轮正在运行，这次没有重复执行'
            : `完成：${done} 个会话产出摘要，${skipped} 个无新内容${failed > 0 ? `，${failed} 个失败` : ''}`,
        );
        setState(data.state);
        setDraft(toDraft(data.state));
      } catch (err) {
        setError(String(err?.message ?? err));
      } finally {
        setBusy('');
      }
    }

    async function showDigest(ref) {
      if (openDigest?.ref === ref) {
        setOpenDigest(null);
        return;
      }
      try {
        const data = await apiGet(`/digest?ref=${encodeURIComponent(ref)}`);
        setOpenDigest({ ref, digest: data.digest, createdAt: data.createdAt });
      } catch (err) {
        setError(String(err?.message ?? err));
      }
    }

    const rooms = state.rooms ?? [];
    const privateRooms = state.privateRooms ?? [];
    const schedule = draft.schedule;
    const enabledCount = draft.groupsEnabled === false
      ? 0
      : rooms.filter((room) => (draft.groups[roomKey(room)]?.enabled ?? true)).length;
    const privateEnabledCount = privateRooms.filter((room) => draft.private?.[roomKey(room)]?.enabled === true).length;

    const duplicateNames = findDuplicateNames(
      rooms.map((room) => draft.groups[roomKey(room)]?.name),
      privateRooms.map((room) => draft.private?.[roomKey(room)]?.name),
    );
    const isDupName = (name) => {
      const key = String(name ?? '').trim().toLowerCase();
      return key !== '' && duplicateNames.has(key);
    };

    return h(
      'div',
      { style: S.wrap },

      // 概览
      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('div', { style: { ...S.cardTitle, marginBottom: 0 } }, 'QQ 群摘要'),
          h('span', { style: S.grow }),
          h('span', { style: S.badge('ok') }, `${enabledCount}/${rooms.length} 个群参与`),
          state.adapterError ? h('span', { style: S.badge('bad') }, '数据源异常') : null,
          h(
            'button',
            { style: S.btnPrimary, disabled: busy !== '', onClick: () => runNow({ alsoSave: true }) },
            busy === 'run' ? '总结中…' : '立即总结',
          ),
        ),
        h(
          'div',
          { style: S.hint },
          `数据源 ${state.source}　·　摘要器 ${draft.summarizer}　·　数据目录 ${state.dataDir}`,
        ),
        state.adapterError
          ? h('div', { style: { ...S.error, marginTop: 6 } }, `数据源错误：${state.adapterError.message}`)
          : null,
        state.policyDegraded
          ? h('div', { style: { ...S.error, marginTop: 6 } }, `配置损坏，已全关（${state.configError}）`)
          : null,
        h('div', { style: S.hint }, '私聊不在本插件的读取范围内：列表里只有群，且没有任何开关能把私聊打开。'),
      ),

      // 总开关
      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('div', { style: { ...S.cardTitle, marginBottom: 0 } }, '群聊读取总开关'),
          h('span', { style: S.grow }),
          h(
            'label',
            { style: { ...S.row, padding: 0, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: draft.groupsEnabled !== false,
              onChange: (event) => setDraft((prev) => ({ ...prev, groupsEnabled: event.target.checked })),
            }),
            h('span', null, draft.groupsEnabled !== false ? '已开启' : '已关闭'),
          ),
        ),
        h(
          'div',
          { style: S.hint },
          draft.groupsEnabled === false
            ? '当前不会读取任何群，单群开关也不生效，定时任务跑了也是空转。'
            : '关掉后所有群一律不读，单群开关同时失效。',
        ),
      ),

      // 群列表
      h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '参与总结的群'),
        rooms.length === 0
          ? h('div', { style: S.empty }, '当前数据源没有返回任何群。桥接只能看到「有消息进过桥接」的群。')
          : h(
              'div',
              { style: S.list },
              rooms.map((room) =>
                h(
                  'div',
                  { key: roomKey(room), style: S.row },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.groups[roomKey(room)]?.enabled ?? true,
                    onChange: () => toggleGroup(roomKey(room)),
                    'aria-label': `启用 ${room.title ?? roomLabel(room)}`,
                  }),
                  h(
                    'div',
                    { style: S.grow },
                    h(
                      'div',
                      { style: S.name },
                      room.title || `群 ${roomLabel(room)}`,
                      h('span', { style: { ...S.mono, marginLeft: 8 } }, roomLabel(room)),
                    ),
                    room.hasDigest
                      ? h(
                          'button',
                          {
                            style: { ...S.btn, padding: '0 8px', fontSize: 11, marginTop: 2 },
                            onClick: () => showDigest(roomKey(room)),
                          },
                          openDigest?.ref === roomKey(room) ? '收起摘要' : '看最新摘要',
                        )
                      : h('span', { style: { ...S.hint, marginTop: 0 } }, '还没有摘要'),
                  ),
                  h('input', {
                    style: isDupName(draft.groups[roomKey(room)]?.name)
                      ? { ...S.input, borderColor: 'var(--dsw-alias-state-error-primary, #d9534f)' }
                      : S.input,
                    placeholder: '群名（可选）',
                    value: draft.groups[roomKey(room)]?.name ?? room.title ?? '',
                    onChange: (event) => renameGroup(roomKey(room), event.target.value),
                  }),
                  isDupName(draft.groups[roomKey(room)]?.name) ? h('span', { style: S.error }, '重名') : null,
                ),
              ),
            ),
        openDigest
          ? h(
              'div',
              { style: { ...S.card, marginTop: 10, background: 'rgba(128,128,128,.06)' } },
              h('div', { style: S.cardTitle }, openDigest.createdAt ? `摘要 · ${openDigest.createdAt}` : '摘要'),
              openDigest.digest
                ? h(DigestView, { digest: openDigest.digest })
                : h('div', { style: S.empty }, '这个群还没有摘要。'),
            )
          : null,
      ),

      // 私聊（默认全关，逐条打开）
      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('div', { style: { ...S.cardTitle, marginBottom: 0 } }, '私聊'),
          h('span', { style: S.grow }),
          h(
            'span',
            { style: S.badge(privateEnabledCount > 0 ? 'warn' : 'ok') },
            privateEnabledCount > 0 ? `已打开 ${privateEnabledCount} 个` : '全部关闭',
          ),
        ),
        privateRooms.length === 0
          ? h('div', { style: S.empty }, '当前数据源没有返回私聊会话。')
          : h(
              'div',
              { style: S.list },
              privateRooms.map((room) =>
                h(
                  'div',
                  { key: roomKey(room), style: S.row },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.private?.[roomKey(room)]?.enabled === true,
                    onChange: () => togglePrivate(setDraft, roomKey(room)),
                    'aria-label': `读取私聊 ${roomLabel(room)}`,
                  }),
                  h(
                    'div',
                    { style: S.grow },
                    h('div', { style: S.name }, draft.private?.[roomKey(room)]?.name || `私聊 ${roomLabel(room)}`),
                    room.hasDigest ? h('span', { style: { ...S.hint, marginTop: 0 } }, '已有摘要') : null,
                  ),
                  h('input', {
                    style: isDupName(draft.private?.[roomKey(room)]?.name)
                      ? { ...S.input, borderColor: 'var(--dsw-alias-state-error-primary, #d9534f)' }
                      : S.input,
                    placeholder: '名字（可选）',
                    value: draft.private?.[roomKey(room)]?.name ?? '',
                    onChange: (event) => renamePrivate(setDraft, roomKey(room), event.target.value),
                  }),
                  isDupName(draft.private?.[roomKey(room)]?.name) ? h('span', { style: S.error }, '重名') : null,
                ),
              ),
            ),
        h(
          'div',
          { style: S.hint },
          '默认全部关闭。勾上之后这个私聊会进入摘要流程，模型能读到它的内容 —— 只能由你在这里逐条打开。',
        ),
        duplicateNames.size > 0
          ? h('div', { style: S.error }, `名字重复：${[...duplicateNames].join('、')}（群和私聊不能同名）`)
          : null,
      ),

      // 摘要器
      h(
        'div',
        { style: S.card },
        h('div', { style: S.cardTitle }, '摘要器'),
        h(
          'div',
          { style: S.row },
          ...[
            ['llm', '模型摘要（质量更好，会产生调用费用）'],
            ['heuristic', '本地规则（零成本，只挑关键词句）'],
          ].map(([value, label]) =>
            h(
              'label',
              { key: value, style: { ...S.row, padding: 0, cursor: 'pointer' } },
              h('input', {
                type: 'radio',
                name: 'qq-digest-summarizer',
                checked: draft.summarizer === value,
                onChange: () => setDraft((prev) => ({ ...prev, summarizer: value })),
              }),
              h('span', null, label),
            ),
          ),
        ),
      ),

      // 定时
      h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('div', { style: { ...S.cardTitle, marginBottom: 0 } }, '定时执行'),
          h('span', { style: S.grow }),
          h(
            'label',
            { style: { ...S.row, padding: 0, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: schedule.enabled,
              onChange: (event) => patchSchedule({ enabled: event.target.checked }),
            }),
            h('span', null, schedule.enabled ? '已开启' : '已关闭'),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('span', null, '频率'),
          h(
            'select',
            {
              style: { ...S.input, width: 120 },
              value: schedule.kind,
              onChange: (event) => patchSchedule({ kind: event.target.value }),
            },
            h('option', { value: 'daily' }, '每天'),
            h('option', { value: 'weekly' }, '每周指定'),
          ),
          h('span', null, '时间'),
          h('input', {
            type: 'time',
            style: { ...S.input, width: 110 },
            value: schedule.time,
            onChange: (event) => patchSchedule({ time: event.target.value }),
          }),
          h('span', { style: { ...S.hint, marginTop: 0 } }, schedule.timeZone),
        ),
        schedule.kind === 'weekly'
          ? h(
              'div',
              { style: S.row },
              h('span', null, '星期'),
              ...WEEKDAYS.map(([code, label]) =>
                h(
                  'button',
                  {
                    key: code,
                    style: S.chip(schedule.weekdays.includes(code)),
                    onClick: () =>
                      patchSchedule({
                        weekdays: schedule.weekdays.includes(code)
                          ? schedule.weekdays.filter((day) => day !== code)
                          : [...schedule.weekdays, code],
                      }),
                  },
                  label,
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: S.hint },
          state.scheduleState?.lastRunAt
            ? `上次执行：${state.scheduleState.lastRunAt}（${state.scheduleState.lastStatus ?? '未知'}）`
            : '还没有执行过定时任务',
        ),
      ),

      // 操作
      h(
        'div',
        { style: S.actions },
        h(
          'button',
          { style: S.btnPrimary, disabled: busy !== '' || !dirty, onClick: save },
          busy === 'save' ? '保存中…' : dirty ? '保存设置' : '已保存',
        ),
        h(
          'button',
          { style: S.btn, disabled: busy !== '', onClick: () => runNow({ alsoSave: true }) },
          busy === 'run' ? '总结中…' : '立即总结',
        ),
        h('span', { style: S.grow }),
        notice ? h('span', { style: S.hint }, notice) : null,
        error ? h('span', { style: S.error }, error) : null,
      ),
    );
  }

  function DigestView({ digest }) {
    const section = (title, items, render) =>
      items.length === 0
        ? null
        : h(
            'div',
            { style: { marginTop: 8 } },
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, title),
            h(
              'ul',
              { style: { margin: 0, paddingLeft: 18 } },
              items.map((item, index) => h('li', { key: index }, render(item))),
            ),
          );

    return h(
      'div',
      null,
      digest.overview ? h('div', null, digest.overview) : null,
      section('重点', digest.highlights ?? [], (item) => String(item)),
      section('任务', digest.tasks ?? [], (task) =>
        [task.what, task.owner && task.owner !== '未指定' ? `（${task.owner}）` : '', task.due ? ` · ${task.due}` : ''].join(''),
      ),
      section('结论', digest.decisions ?? [], (item) => String(item)),
      section('待回答', digest.questions ?? [], (item) => String(item)),
    );
  }

  // ── 草稿 ↔ 服务端状态 ───────────────────────────────────────────────────

  function togglePrivate(setDraft, qq) {
    setDraft((prev) => {
      const current = prev.private?.[qq] ?? { enabled: false, name: '' };
      return { ...prev, private: { ...prev.private, [qq]: { ...current, enabled: !current.enabled } } };
    });
  }

  function renamePrivate(setDraft, qq, name) {
    setDraft((prev) => {
      const current = prev.private?.[qq] ?? { enabled: false, name: '' };
      return { ...prev, private: { ...prev.private, [qq]: { ...current, name } } };
    });
  }

  /** 会话的稳定键：优先用服务端下发的 ref（脱敏后不再有群号/QQ 号），兼容旧响应的原始 id。 */
  function roomKey(room) {
    return room?.ref ?? room?.groupId ?? room?.qq ?? '';
  }

  /** 给人看的标识：优先掩码，旧响应没有掩码时才退回原始 id。 */
  function roomLabel(room) {
    return room?.groupIdMasked ?? room?.qqMasked ?? room?.groupId ?? room?.qq ?? '';
  }

  function toDraft(state) {
    const groups = {};
    for (const room of state.rooms ?? []) {
      groups[roomKey(room)] = {
        enabled: room.enabled !== false,
        name: room.named ? room.title ?? '' : '', // 只有用户显式命名过的才回填
      };
    }
    const privateDraft = {};
    for (const room of state.privateRooms ?? []) {
      privateDraft[roomKey(room)] = {
        enabled: room.enabled === true,
        name: room.named ? room.name ?? '' : '',
      };
    }

    return {
      groupsEnabled: state.groupsEnabled !== false,
      groups,
      private: privateDraft,
      summarizer: state.summarizer === 'heuristic' ? 'heuristic' : 'llm',
      schedule: {
        enabled: Boolean(state.schedule?.enabled),
        kind: state.schedule?.kind === 'daily' ? 'daily' : 'weekly',
        weekdays: Array.isArray(state.schedule?.weekdays) ? [...state.schedule.weekdays] : ['MO', 'TU', 'WE', 'TH', 'FR'],
        time: state.schedule?.time ?? '09:00',
        timeZone: state.schedule?.timeZone ?? 'Asia/Shanghai',
      },
    };
  }

  /** 只把「关掉的群」和「改过名的群」写进配置：默认全开，不制造一堆无意义的覆盖项。 */
  function buildGroupsPayload(draft) {
    const payload = {};
    for (const [groupId, entry] of Object.entries(draft.groups)) {
      const name = String(entry.name ?? '').trim();
      if (entry.enabled !== false && name === '') continue;
      payload[groupId] = entry.enabled !== false ? { enabled: true, name } : { enabled: false, ...(name ? { name } : {}) };
    }
    return payload;
  }

  /**
   * 找出重复的名字（trim + 忽略大小写）。群和私聊合并判定 ——
   * 摘要列表里只显示名字，两处同名就分不清了。
   * @returns {Set<string>} 归一化后的重名集合
   */
  function findDuplicateNames(groupNames, privateNames) {
    const seen = new Set();
    const duplicates = new Set();
    for (const name of [...groupNames, ...privateNames]) {
      const key = String(name ?? '').trim().toLowerCase();
      if (key === '') continue;
      if (seen.has(key)) duplicates.add(key);
      else seen.add(key);
    }
    return duplicates;
  }

  /**
   * 私聊开关一律显式写全（含 false）：
   * 之前打开过、现在关掉的那条必须写 false，否则旧配置还留着 enabled:true。
   */
  function buildPrivatePayload(draft) {
    const payload = {};
    for (const [qq, entry] of Object.entries(draft.private ?? {})) {
      const name = String(entry?.name ?? '').trim();
      payload[qq] = { enabled: entry?.enabled === true, ...(name ? { name } : {}) };
    }
    return payload;
  }

  // ── 注册 ────────────────────────────────────────────────────────────────

  const inject = ['slots'];

  const SLOT_RETRY_LIMIT = 20;
  const SLOT_RETRY_DELAY_MS = 50;

  /**
   * slots 服务可能晚于 apply 发布。读不到就重试，绝不静默放弃 ——
   * 静默放弃的表现是「插件显示已安装、设置页里却没有这一项」，极难排查。
   */
  function resolveSlots(ctx) {
    try {
      return ctx.slots !== undefined ? ctx.slots : ctx.get('slots');
    } catch (err) {
      console.error('[qq-digest] 读取 slots 服务失败：' + String(err && err.message ? err.message : err));
      return undefined;
    }
  }

  function mount(ctx, slots) {
    try {
      const off = slots.inject(SLOT, () =>
        slots.register({ name: SLOT, id: SECTION_ID, order: ORDER, label: 'QQ 群摘要' }, () => h(Panel, null)),
      );
      if (typeof ctx.effect === 'function' && typeof off === 'function') ctx.effect(() => off);
      ping('mounted', { sectionId: SECTION_ID });
      return true;
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      console.error('[qq-digest] 注册设置页失败：' + detail);
      ping('mount-failed', { error: detail });
      return false;
    }
  }

  function apply(ctx) {
    const immediate = resolveSlots(ctx);
    if (immediate !== undefined) {
      mount(ctx, immediate);
      return;
    }

    let attempt = 0;
    const retry = () => {
      attempt += 1;
      const late = resolveSlots(ctx);
      if (late !== undefined) {
        mount(ctx, late);
        return;
      }
      if (attempt >= SLOT_RETRY_LIMIT) {
        console.error(`[qq-digest] 宿主没有发布 slots 服务（重试 ${SLOT_RETRY_LIMIT} 次），设置页未注册`);
        ping('slot-missing', { attempts: attempt });
        return;
      }
      setTimeout(retry, SLOT_RETRY_DELAY_MS);
    };
    setTimeout(retry, SLOT_RETRY_DELAY_MS);
  }

  exports.apply = apply;
  exports.inject = inject;
  exports.__test = { detectBase, toDraft, buildGroupsPayload, buildPrivatePayload, findDuplicateNames };

  return module.exports;
  },
});
