window.__ModuleLoader__.load({
  id: '@carlopenlab/dsh-acp-hub',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef } = React;
    const labels = { codex: 'Codex', 'claude-code': 'Claude Code', pi: 'pi', 'oh-my-pi': 'oh-my-pi', deepseek: 'DeepSeek' };
    const API = '/acp-hub/api';

    async function call(path, method = 'GET', body) {
      const response = await fetch(API + path, {
        method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-acp': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }

    function useStateFeed() {
      const [state, setState] = useState({ agents: [], profiles: [], sessions: [] });
      const [error, setError] = useState('');
      const refresh = async () => {
        try { setState(await call('/state')); } catch (error) { setError(error.message); }
      };
      useEffect(() => {
        let active = true;
        const poll = async () => {
          try { const value = await call('/state'); if (active) setState(value); }
          catch (error) { if (active) setError(error.message); }
        };
        void poll();
        const timer = setInterval(poll, 2000);
        return () => { active = false; clearInterval(timer); };
      }, []);
      return { state, refresh, error, setError };
    }

    const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
    function Field({ label, children, hint }) {
      return h('label', { className: 'acph-field' }, h('span', null, label), children,
        hint ? h('small', null, hint) : null);
    }

    function ProfileEditor({ agents, initial, onSaved, onCancel }) {
      const defaults = agents.find(a => a.id === (initial?.agent || 'codex'));
      const [draft, setDraft] = useState(initial || {
        id: '', name: '', agent: 'codex', provider: '', baseURL: '', model: '',
        command: defaults?.command || 'npx', args: defaults?.args || ['-y', '@agentclientprotocol/codex-acp'], env: {},
      });
      const [key, setKey] = useState('');
      const [clearKey, setClearKey] = useState(false);
      const [args, setArgs] = useState(JSON.stringify(draft.args));
      const [env, setEnv] = useState(JSON.stringify(draft.env || {}, null, 2));
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const change = (name, value) => setDraft(d => ({ ...d, [name]: value }));
      const input = (name, placeholder) => h('input', { value: draft[name] || '', placeholder,
        onChange: e => change(name, e.target.value) });
      async function save(e) {
        e.preventDefault(); setBusy(true); setError('');
        try {
          const payload = { ...draft, args: JSON.parse(args), env: JSON.parse(env),
            ...(key ? { apiKey: key } : clearKey ? { apiKey: '' } : {}) };
          delete payload.hasApiKey;
          await call('/profiles', 'POST', payload);
          onSaved();
        } catch (error) { setError(error.message); } finally { setBusy(false); }
      }
      return h('form', { className: 'acph-editor', onSubmit: save },
        h('div', { className: 'acph-row' }, h('h3', null, initial ? '编辑连接' : '添加连接'), button('关闭', onCancel)),
        h('div', { className: 'acph-fields' },
          h(Field, { label: '连接名称' }, input('name', '例如：Codex · 我的网关')),
          h(Field, { label: '执行代理' }, h('select', { value: draft.agent, onChange: e => {
            const spec = agents.find(a => a.id === e.target.value);
            setDraft(d => ({ ...d, agent: e.target.value, command: spec.command, args: spec.args }));
            setArgs(JSON.stringify(spec.args));
          } }, ...agents.map(a => h('option', { key: a.id, value: a.id }, labels[a.id])))),
          h(Field, { label: '服务商名称', hint: '用于区分不同连接；真正的路由由地址和代理配置决定。' }, input('provider', 'OpenAI / Anthropic / 我的网关')),
          h(Field, { label: '服务商 API 地址', hint: draft.agent === 'codex' ? 'Codex 自定义端点需要支持 Responses API。留空使用 Codex 本机配置。' : 'Claude Code 使用 Anthropic 兼容端点；留空使用本机配置。' }, input('baseURL', 'https://api.example.com/v1')),
          h(Field, { label: 'API Key', hint: initial?.hasApiKey ? '已保存。留空保留原凭据。' : '留空使用代理本机登录。' }, h('input', { type: 'password', autoComplete: 'new-password', value: key, onChange: e => setKey(e.target.value) })),
          h(Field, { label: '默认模型', hint: '连接后可使用代理公布的模型选择器调整。' }, input('model', '留空使用代理默认模型')),
        ),
        initial?.hasApiKey ? h('label', { className: 'acph-check' }, h('input', { type: 'checkbox', checked: clearKey, onChange: e => setClearKey(e.target.checked) }), '删除已保存的 API Key') : null,
        h('details', null, h('summary', null, '高级启动配置'),
          h(Field, { label: '命令' }, input('command', 'npx')),
          h(Field, { label: '参数（JSON 数组）' }, h('textarea', { rows: 2, value: args, onChange: e => setArgs(e.target.value) })),
          h(Field, { label: '环境变量（JSON 对象）', hint: 'pi 等代理的服务商设置请使用其支持的环境变量。' }, h('textarea', { rows: 5, value: env, onChange: e => setEnv(e.target.value) }))),
        error ? h('p', { role: 'alert', className: 'acph-error' }, error) : null,
        h('button', { type: 'submit', className: 'acph-primary', disabled: busy }, busy ? '保存中…' : '保存连接'),
      );
    }

    function useAcpSession(sessionId, provider) {
      const [state, setState] = useState({ sessions: [] });
      const [error, setError] = useState('');
      useEffect(() => {
        let active = true;
        if (!sessionId || !provider?.startsWith('acp-hub/')) return () => { active = false; };
        void call('/sessions/claim', 'POST', { nativeSessionId: String(sessionId) }).catch(() => {});
        const poll = async () => {
          try {
            const value = await call('/state');
            if (active) { setState(value); setError(''); }
          } catch (error) { if (active) setError(error.message); }
        };
        void poll();
        const timer = setInterval(poll, 1000);
        return () => { active = false; clearInterval(timer); };
      }, [sessionId, provider]);
      const session = state.sessions.find(item => item.nativeSessionId === String(sessionId) && item.nativeProvider === provider);
      return { session, error };
    }

    function PermissionDialog({ session, onResolve, busy, error }) {
      const request = session?.pendingPermissions?.[0];
      if (!request) return null;
      const raw = request.raw || {};
      const tool = raw.toolCall || {};
      const options = request.options || [];
      const hasReject = options.some(option => option.kind?.startsWith('reject'));
      const choose = optionId => onResolve(request.requestId, optionId);
      return h('div', { className: 'acph-permission-backdrop', role: 'presentation' },
        h('div', { className: 'acph-permission-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acph-permission-title' },
          h('div', { className: 'acph-row' }, h('strong', { id: 'acph-permission-title' }, 'Claude 请求权限'),
            h('span', { className: 'acph-permission-count' }, `${session.pendingPermissions.length} 个待处理`)),
          h('p', { className: 'acph-permission-tool' }, tool.title || 'ACP 工具操作'),
          tool.kind ? h('p', { className: 'acph-muted' }, `类型：${tool.kind}`) : null,
          h('p', { className: 'acph-muted' }, '请确认是否允许此代理执行当前操作。选择后可以继续切换工作模式。'),
          h('div', { className: 'acph-permission-actions' },
            ...options.map(option => button(option.name || option.optionId, () => choose(option.optionId), {
              key: option.optionId, disabled: busy, className: option.kind?.startsWith('reject') ? 'acph-danger' : 'acph-primary',
            })),
            hasReject ? null : button('拒绝', () => choose(undefined), { disabled: busy, className: 'acph-danger' })),
          error ? h('p', { role: 'alert', className: 'acph-error' }, error) : null,
        ),
      );
    }

    function AgentModelSelect({ sessionId, directory, load, select, locked, discover }) {
      const state = React.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const current = state.current;
      const currentAgent = current?.provider.startsWith('acp-hub/') ? current.provider.split('/')[1] : 'dsh';
      const acp = useAcpSession(sessionId, current?.provider);
      const [agent, setAgent] = useState(currentAgent);
      const [provider, setProvider] = useState(current?.provider || '');
      const [models, setModels] = useState(null);
      const [sessionBusy, setSessionBusy] = useState(false);
      const [sessionError, setSessionError] = useState('');
      const wrapper = useRef(null);
      useEffect(() => {
        if (!open) return;
        const close = e => { if (!wrapper.current?.contains(e.target)) setOpen(false); };
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
      }, [open]);
      const groups = state.groups.filter(group => agent === 'dsh' ? !group.id.startsWith('acp-hub/') : group.id.startsWith(`acp-hub/${agent}/`));
      useEffect(() => { if (!groups.some(group => group.id === provider)) setProvider(groups[0]?.id || ''); }, [agent, state.groups]);
      const chosen = groups.find(group => group.id === provider) || groups[0];
      const choices = models || chosen?.models || [];
      const currentChoice = choices.find(model => chosen?.id === current?.provider && model.id === current?.model);
      async function choose(model) {
        if (!chosen) return;
        setBusy(true); setError('');
        try {
          const reasoningEffort = currentChoice?.id === model ? current?.reasoningEffort : choices.find(choice => choice.id === model)?.reasoning?.defaultEffort;
          const accepted = await select({ provider: chosen.id, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
          if (!accepted) throw new Error('无法切换当前会话的模型');
          setOpen(false);
        } catch (error) { setError(error.message); } finally { setBusy(false); }
      }
      async function changeMode(mode) {
        const currentMode = acp.session?.modes?.currentModeId;
        if (!acp.session || mode.id === currentMode) return;
        if (!window.confirm(`切换工作模式为「${mode.name || mode.id}」？之后可随时切回。`)) return;
        setSessionBusy(true); setSessionError('');
        try {
          await call(`/sessions/${acp.session.id}/mode`, 'POST', { modeId: mode.id });
        } catch (error) { setSessionError(error.message); } finally { setSessionBusy(false); }
      }
      async function resolvePermission(requestId, optionId) {
        if (!acp.session) return;
        setSessionBusy(true); setSessionError('');
        try {
          await call(`/sessions/${acp.session.id}/permission`, 'POST', { requestId, ...(optionId ? { optionId } : {}) });
        } catch (error) { setSessionError(error.message); } finally { setSessionBusy(false); }
      }
      return h('div', { className: 'acph-model-select', ref: wrapper },
        button(`${labels[currentAgent] || 'DSH'} · ${current?.model === 'default' ? '默认模型' : current?.model || '选择模型'}`, () => {
          setAgent(currentAgent); setProvider(current?.provider || ''); setModels(null); load(); setOpen(value => !value);
        }, { disabled: locked, 'aria-label': '选择 Agent、服务商和模型', 'aria-expanded': open, 'aria-haspopup': 'dialog' }),
        open ? h('div', { className: 'acph-model-menu', role: 'dialog', 'aria-label': 'Agent 与模型选择', onKeyDown: e => { if (e.key === 'Escape') setOpen(false); } },
          h('div', { className: 'acph-row' }, h('strong', null, '执行代理'), button('关闭', () => setOpen(false))),
          h(Field, { label: 'Agent' }, h('select', { value: agent, disabled: busy, onChange: e => {
            setAgent(e.target.value); setProvider(''); setModels(null);
          } }, h('option', { value: 'dsh' }, 'DSH 原生'), ...Object.entries(labels).map(([id, label]) => h('option', { key: id, value: id }, label)))),
          h(Field, { label: '服务商 / 连接' }, h('select', { value: chosen?.id || '', disabled: busy, onChange: e => { setProvider(e.target.value); setModels(null); } },
            ...groups.map(group => h('option', { key: group.id, value: group.id }, group.name)))),
          agent !== 'dsh' ? button(busy ? '读取中…' : '读取代理模型', async () => {
            if (!chosen) return;
            setBusy(true); setError('');
            try { const result = await discover(chosen.id); setModels(result.models); }
            catch (error) { setError(error.message); } finally { setBusy(false); }
          }, { disabled: busy || !chosen }) : null,
          h('div', { className: 'acph-model-list' }, ...choices.map(model => button(model.name || model.id, () => choose(model.id), {
            key: model.id, disabled: busy, 'aria-pressed': current?.provider === chosen?.id && current?.model === model.id,
          }))),
          currentChoice?.reasoning ? h(Field, { label: '推理强度' }, h('select', {
            value: current?.reasoningEffort || currentChoice.reasoning.defaultEffort || '', disabled: busy,
            onChange: async e => {
              setBusy(true); setError('');
              try {
                const reasoningEffort = e.target.value;
                if (!await select({ provider: chosen.id, model: current.model, ...(reasoningEffort ? { reasoningEffort } : {}) })) throw new Error('无法切换推理强度');
              } catch (error) { setError(error.message); } finally { setBusy(false); }
            },
          }, h('option', { value: '' }, '服务商默认'), ...currentChoice.reasoning.efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)))) : null,
          acp.session?.modes?.availableModes?.length ? h(Field, { label: '工作模式', hint: '切换后仍可随时选回其他模式。' }, h('select', {
            value: acp.session.modes.currentModeId || '', disabled: sessionBusy || busy || acp.session.status !== 'idle',
            onChange: e => { const mode = acp.session.modes.availableModes.find(item => item.id === e.target.value); if (mode) void changeMode(mode); },
          }, ...acp.session.modes.availableModes.map(mode => h('option', { key: mode.id, value: mode.id }, mode.name || mode.id)))) : null,
          agent !== 'dsh' ? h('small', null, '消息、历史和停止操作使用 dsh 原生会话；该代理的服务商连接在「设置 → ACP 代理」管理。') : null,
          error || state.error || acp.error || sessionError ? h('p', { role: 'alert', className: 'acph-error' }, error || state.error || acp.error || sessionError) : null,
        ) : null,
        acp.session?.pendingPermissions?.length ? h(PermissionDialog, { session: acp.session, onResolve: resolvePermission, busy: sessionBusy, error: sessionError }) : null,
      );
    }

    function ConnectionSettings() {
      const { state, refresh, error, setError } = useStateFeed();
      const [editor, setEditor] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      async function run(action) {
        setBusy(true); setError(''); setNotice('');
        try { await action(); await refresh(); }
        catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }
      return h('section', { className: 'acph-settings' },
        h('div', { className: 'acph-row' }, h('h3', null, 'ACP 代理与服务商'), button('添加连接', () => setEditor(null))),
        h('p', null, '在聊天输入框的模型按钮中选择 Agent → 服务商 / 连接 → 模型，然后使用 dsh 的会话和输入框开始工作。'),
        h('p', { className: 'acph-muted' }, '本机登录无需添加连接。自定义网关可在这里保存地址、凭据和默认模型；更换连接后请新建会话使用新配置。'),
        editor !== undefined ? h(ProfileEditor, { key: editor?.id || 'new', agents: state.agents, initial: editor,
          onCancel: () => setEditor(undefined), onSaved: () => { setEditor(undefined); void refresh(); } }) : null,
        ...state.profiles.map(profile => h('div', { key: profile.id, className: 'acph-profile' },
          h('div', null, h('strong', null, profile.name), h('small', null, `${labels[profile.agent]} · ${profile.provider || '本机配置'}`)),
          button('测试连接', () => run(async () => {
            const result = await call('/test', 'POST', { agent: profile.agent, profileId: profile.id });
            setNotice(`连接成功 · ACP ${result.capabilities.protocolVersion}`);
          }), { disabled: busy }),
          button('编辑', () => setEditor(profile), { disabled: busy }),
          button('删除', () => {
            if (window.confirm(`删除连接「${profile.name}」？`)) void run(() => call(`/profiles/${profile.id}`, 'DELETE'));
          }, { disabled: busy }))),
        state.profiles.length ? null : h('p', { className: 'acph-muted' }, '尚未添加服务商连接。可以直接选择 Agent 的「本机登录」。'),
        notice ? h('p', { role: 'status' }, notice) : null,
        error ? h('p', { role: 'alert', className: 'acph-error' }, error) : null,
      );
    }

    const css = `
.acph-model-select{position:relative;font:inherit}.acph-model-select>button{border:0;border-radius:8px;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);padding:6px 10px;cursor:pointer;font:inherit}.acph-model-menu{position:absolute;bottom:calc(100% + 12px);right:0;width:min(360px,calc(100vw - 80px));max-height:65vh;overflow:auto;z-index:100;padding:14px;display:flex;flex-direction:column;gap:10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#8884);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3,0 8px 24px #0003)}.acph-model-menu .acph-field{margin:0}.acph-model-menu select,.acph-model-menu button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:7px;padding:8px;cursor:pointer}.acph-model-menu button:disabled{opacity:.5}.acph-model-list{display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto}.acph-model-list button{text-align:left}.acph-model-list button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#2469d8)}
.acph-settings{padding:20px;display:flex;flex-direction:column;gap:14px;font:inherit;color:var(--dsw-alias-label-primary)}.acph-settings *{box-sizing:border-box}.acph-settings h3,.acph-settings p{margin:0}.acph-settings p{line-height:1.6}.acph-settings button,.acph-settings input,.acph-settings textarea,.acph-settings select{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px}.acph-settings button{cursor:pointer}.acph-settings button:disabled{opacity:.5}.acph-settings :focus-visible,.acph-model-select :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2469d8);outline-offset:2px}.acph-settings .acph-primary{background:var(--dsw-alias-button-primary-fill,#2469d8);color:var(--dsw-alias-label-primary-inverted,#fff)}.acph-row,.acph-profile{display:flex;align-items:center;gap:10px;justify-content:space-between}.acph-profile{padding:12px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:10px}.acph-profile>div{flex:1;min-width:0}.acph-profile small{display:block;margin-top:4px}.acph-muted,.acph-profile small,.acph-field small{color:var(--dsw-alias-label-secondary);font-size:12px}.acph-field{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}.acph-field>span{font-size:12px;font-weight:550}.acph-editor{padding:16px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:12px}.acph-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:15px}.acph-field input,.acph-field select,.acph-field textarea{min-width:0;width:100%}.acph-check{display:flex;gap:8px;align-items:center;margin:10px 0}.acph-editor details{margin:12px 0}.acph-editor details[open] summary{margin-bottom:12px}.acph-error{color:var(--dsw-alias-state-error-primary,#b52e36);overflow-wrap:anywhere}.acph-model-select>button:disabled{opacity:.5;cursor:default}
.acph-permission-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:18px;background:#0006}.acph-permission-dialog{box-sizing:border-box;width:min(460px,calc(100vw - 32px));padding:18px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3,0 12px 36px #0005)}.acph-permission-dialog p{margin:0;line-height:1.5}.acph-permission-tool{font-weight:600;overflow-wrap:anywhere}.acph-permission-count{color:var(--dsw-alias-label-secondary);font-size:12px}.acph-permission-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}.acph-permission-actions button{font:inherit;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer}.acph-permission-actions button:disabled{opacity:.5}.acph-permission-actions .acph-primary{background:var(--dsw-alias-button-primary-fill,#2469d8);color:var(--dsw-alias-label-primary-inverted,#fff)}.acph-permission-actions .acph-danger{border-color:var(--dsw-alias-state-error-primary,#b52e36);color:var(--dsw-alias-state-error-primary,#b52e36)}
@media(max-width:760px){.acph-settings{padding:12px}.acph-fields{grid-template-columns:1fr}.acph-profile{flex-wrap:wrap}.acph-profile>div{flex-basis:100%}.acph-model-menu{box-sizing:border-box;right:8px}}
`;

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.dataset.pluginCss = 'acp-hub'; style.textContent = css;
        document.head.appendChild(style); return () => style.remove();
      }, 'acp-hub: styles');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'acp-hub', order: 12,
        label: 'ACP 代理' }, ConnectionSettings));
      ctx.inject(['modelDirectories', 'sessions', 'remote', 'remote.session'], scope => {
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
          name: 'conversation.input.model', priority: -10, inject: sessionId => {
            const directory = scope.modelDirectories.directoryFor(sessionId);
            return { sessionId, directory: directory.store, load: () => directory.load().catch(() => {}),
              select: selection => directory.select(selection).then(() => true, () => false),
              discover: async provider => {
                const binding = scope.sessions.binding(sessionId);
                const snapshot = binding?.session?.getSnapshot?.();
                const cwd = snapshot?.header?.cwd || binding?.session?.header?.cwd;
                return call('/native/discover', 'POST', { provider, cwd: cwd || '/tmp' });
              },
            };
          },
        }, AgentModelSelect));
      });
    }
    return { inject: ['slots'], apply };
  },
});
