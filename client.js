/**
 * dsh-mcp-hub — Client half.
 *
 * Registers the "MCP 管理" settings page. The page reads and mutates the
 * Host's registry through the `mcpHub` Remote namespace; every value it renders
 * comes from that namespace, so the page never guesses at disk state.
 *
 * @module dsh-mcp-hub/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PKG = 'dsh-mcp-hub';
    const NS = 'mcp-hub';
    const STYLE_ID = 'dsh-mcp-hub-styles';

    /* ---------------------------------------------------------------- *
     * Remote descriptors
     *
     * The Host half uses the gateway's source mode (it installs the
     * `@deepseek-ai/dsh-typert-protocol/remote-methods` prototype marker), so
     * these descriptors only have to agree on namespace, method name and the
     * wire name of each parameter — which is the Host method's parameter name.
     * The Client requires `mode: 'strict'` on parameter codecs and never calls
     * them, because the Host validates every argument itself.
     * ---------------------------------------------------------------- */

    function codec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol: `${PKG}/types#${typeSymbol}`,
        create: () => ({ parse: (value) => value }),
      };
    }

    function endpoint(method, parameters = []) {
      return {
        id: `${PKG}#mcpHub/${method}`,
        service: 'mcpHub',
        namespace: 'mcpHub',
        method,
        invocation: { kind: 'direct' },
        parameters,
        result: { mode: 'src-json' },
      };
    }

    function payload(typeSymbol) {
      return [{ name: 'payload', wire: 'payload', source: 'json', codec: codec(typeSymbol) }];
    }

    const REMOTE = {
      package: PKG,
      descriptors: [
        endpoint('state'),
        endpoint('heartbeat'),
        endpoint('upsert', payload('UpsertInput')),
        /* Named `removeServer`, not `remove`: the Client refuses a Remote method
           that shadows `RemoteNamespaceService.prototype.remove`. */
        endpoint('removeServer', payload('IdInput')),
        endpoint('toggle', payload('ToggleInput')),
        endpoint('reload', payload('IdInput')),
        endpoint('test', payload('TestInput')),
        endpoint('invoke', payload('InvokeInput')),
        endpoint('importJson', payload('ImportInput')),
        endpoint('exportJson'),
        endpoint('applyPreset', payload('PresetInput')),
        endpoint('clearErrors'),
      ],
    };

    /* ---------------------------------------------------------------- *
     * Dictionaries
     * ---------------------------------------------------------------- */

    const zh = {
      nav: 'MCP 管理',
      title: 'MCP 服务器',
      subtitle: '集中管理 stdio / Streamable HTTP / SSE 三种传输的 MCP 服务端，工具以 mcp__名称__工具 注册给模型。',
      registry: '配置文件',
      refresh: '刷新',
      add: '新增服务器',
      presets: '预设',
      import: '导入',
      export: '导出',
      clearErrors: '清除错误',
      loading: '加载中…',
      mountMissing: '无法连接 Harness 主机侧的 MCP 服务，请刷新页面重试',
      empty: '还没有配置任何 MCP 服务器。可以从预设开始，或点「新增服务器」。',
      colName: '名称',
      colTransport: '传输',
      colTarget: '目标',
      colStatus: '状态',
      colTools: '工具',
      edit: '编辑',
      test: '测试',
      reconnect: '重连',
      remove: '删除',
      confirmRemove: '确定删除这个 MCP 服务器？',
      enabled: '已启用',
      disabled: '已停用',
      state_idle: '未连接',
      state_connecting: '连接中',
      state_connected: '已连接',
      state_reconnecting: '重连中',
      state_error: '错误',
      state_disabled: '已停用',
      toolsCount: (n) => `${n} 个工具`,
      noTools: '该服务端没有暴露工具',
      callTitle: '调用工具',
      callArgs: '参数（JSON）',
      callRun: '执行',
      callRunning: '执行中…',
      callResult: '结果',
      editorNew: '新增 MCP 服务器',
      editorEdit: '编辑 MCP 服务器',
      fieldName: '名称（模型可见命名空间）',
      fieldNameHint: '只允许 A-Za-z0-9_-，≤32 字符，工具名形如 mcp__名称__工具',
      fieldTransport: '传输方式',
      transport_stdio: 'stdio（本地进程）',
      transport_streamableHttp: 'Streamable HTTP',
      transport_sse: 'SSE（旧版 HTTP+SSE，Burp / Yakit）',
      fieldUrl: '端点 URL',
      fieldUrlHint: '例如 http://127.0.0.1:9876/sse',
      fieldCommand: '命令',
      fieldArgs: '参数（空格分隔，可用引号）',
      fieldCwd: '工作目录（可选）',
      fieldEnv: '环境变量（JSON，可选）',
      fieldHeaders: '请求头（JSON，可选）',
      fieldTimeout: '工具调用超时（毫秒）',
      fieldReconnect: '断线自动重连',
      fieldDescription: '备注（可选）',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      testDraft: '测试连接',
      testing: '测试中…',
      testOk: '连接成功',
      testFail: '连接失败',
      importTitle: '从 JSON 导入',
      importHint: '支持 Claude/Cursor 的 {"mcpServers": {...}}、本插件导出的数组，或单条服务器记录。',
      importRun: '导入',
      importing: '导入中…',
      importDone: (n) => `已导入 ${n} 个服务器`,
      exportTitle: '导出为 JSON',
      exportHint: '可以直接粘贴到其他 MCP 客户端（Claude Code / Cursor 等）。',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
      advanced: '高级',
      serverInfo: '服务端',
      protocol: '协议版本',
      instructions: '服务端指令',
    };

    const en = {
      nav: 'MCP Hub',
      title: 'MCP servers',
      subtitle: 'Manage stdio / Streamable HTTP / SSE MCP servers. Tools register for the model as mcp__name__tool.',
      registry: 'Registry file',
      refresh: 'Refresh',
      add: 'Add server',
      presets: 'Presets',
      import: 'Import',
      export: 'Export',
      clearErrors: 'Clear errors',
      loading: 'Loading…',
      mountMissing: 'The Harness host-side MCP service is unreachable; refresh the page and retry',
      empty: 'No MCP server configured yet. Start from a preset, or add one.',
      colName: 'Name',
      colTransport: 'Transport',
      colTarget: 'Target',
      colStatus: 'Status',
      colTools: 'Tools',
      edit: 'Edit',
      test: 'Test',
      reconnect: 'Reconnect',
      remove: 'Delete',
      confirmRemove: 'Delete this MCP server?',
      enabled: 'Enabled',
      disabled: 'Disabled',
      state_idle: 'Idle',
      state_connecting: 'Connecting',
      state_connected: 'Connected',
      state_reconnecting: 'Reconnecting',
      state_error: 'Error',
      state_disabled: 'Disabled',
      toolsCount: (n) => `${n} tool(s)`,
      noTools: 'This server exposes no tools',
      callTitle: 'Call a tool',
      callArgs: 'Arguments (JSON)',
      callRun: 'Run',
      callRunning: 'Running…',
      callResult: 'Result',
      editorNew: 'Add MCP server',
      editorEdit: 'Edit MCP server',
      fieldName: 'Name (model-visible namespace)',
      fieldNameHint: 'A-Za-z0-9_- only, at most 32 chars; tools appear as mcp__name__tool',
      fieldTransport: 'Transport',
      transport_stdio: 'stdio (local process)',
      transport_streamableHttp: 'Streamable HTTP',
      transport_sse: 'SSE (legacy HTTP+SSE, Burp / Yakit)',
      fieldUrl: 'Endpoint URL',
      fieldUrlHint: 'e.g. http://127.0.0.1:9876/sse',
      fieldCommand: 'Command',
      fieldArgs: 'Arguments (space separated, quotes allowed)',
      fieldCwd: 'Working directory (optional)',
      fieldEnv: 'Environment (JSON, optional)',
      fieldHeaders: 'Headers (JSON, optional)',
      fieldTimeout: 'Tool call timeout (ms)',
      fieldReconnect: 'Reconnect automatically',
      fieldDescription: 'Note (optional)',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      testDraft: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected',
      testFail: 'Connection failed',
      importTitle: 'Import from JSON',
      importHint: 'Accepts Claude/Cursor {"mcpServers": {...}}, this plugin\'s exported array, or a single server record.',
      importRun: 'Import',
      importing: 'Importing…',
      importDone: (n) => `Imported ${n} server(s)`,
      exportTitle: 'Export as JSON',
      exportHint: 'Paste it into any other MCP client (Claude Code, Cursor, …).',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
      advanced: 'Advanced',
      serverInfo: 'Server',
      protocol: 'Protocol',
      instructions: 'Server instructions',
    };

    /* ---------------------------------------------------------------- *
     * Styles — theme tokens only, prefixed classes
     * ---------------------------------------------------------------- */

    const CSS = `
.mcp-hub-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; }
.mcp-hub-head { display: flex; flex-direction: column; gap: 4px; }
.mcp-hub-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mcp-hub-sub { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.mcp-hub-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.mcp-hub-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mcp-hub-spacer { flex: 1 1 auto; }
.mcp-hub-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.mcp-hub-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.mcp-hub-btn:disabled { opacity: .5; cursor: default; }
.mcp-hub-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.mcp-hub-btn-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--dsw-alias-brand-primary); }
.mcp-hub-btn-danger { color: var(--dsw-alias-state-error-primary); }
.mcp-hub-list { display: flex; flex-direction: column; gap: 10px; }
.mcp-hub-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.mcp-hub-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; flex-wrap: wrap; }
.mcp-hub-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 180px; flex: 1 1 220px; }
.mcp-hub-name { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mcp-hub-target { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.mcp-hub-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mcp-hub-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; letter-spacing: .02em; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.mcp-hub-badge-sse { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.mcp-hub-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.mcp-hub-dot-connected { background: var(--dsw-alias-state-success-primary); }
.mcp-hub-dot-error { background: var(--dsw-alias-state-error-primary); }
.mcp-hub-dot-connecting, .mcp-hub-dot-reconnecting { background: var(--dsw-alias-state-warn-primary); }
.mcp-hub-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.mcp-hub-error { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.mcp-hub-detail { border-top: 1px solid var(--dsw-alias-border-l1); padding: 11px 12px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-base); }
.mcp-hub-tools { display: flex; flex-direction: column; gap: 4px; }
.mcp-hub-tool { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.mcp-hub-tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); cursor: pointer; background: none; border: none; padding: 0; text-align: left; }
.mcp-hub-tool-name:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
.mcp-hub-tool-desc { color: var(--dsw-alias-label-secondary); }
.mcp-hub-form { display: flex; flex-direction: column; gap: 10px; }
.mcp-hub-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.mcp-hub-field { display: flex; flex-direction: column; gap: 4px; }
.mcp-hub-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.mcp-hub-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.mcp-hub-input, .mcp-hub-select, .mcp-hub-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 6px 8px; font-family: inherit; }
.mcp-hub-textarea { min-height: 92px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5; }
.mcp-hub-input:focus, .mcp-hub-select:focus, .mcp-hub-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mcp-hub-switch { width: 34px; height: 19px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); position: relative; cursor: pointer; padding: 0; flex: 0 0 auto; }
.mcp-hub-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.mcp-hub-knob { position: absolute; top: 1.5px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: transform .14s ease; }
.mcp-hub-switch[aria-checked="true"] .mcp-hub-knob { transform: translateX(14px); }
.mcp-hub-pre { margin: 0; padding: 9px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.mcp-hub-note { font-size: 11.5px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); word-break: break-word; }
.mcp-hub-note-ok { color: var(--dsw-alias-state-success-primary); }
.mcp-hub-note-error { color: var(--dsw-alias-state-error-primary); }
.mcp-hub-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding: 9vh 16px 16px; background: rgba(0,0,0,.34); }
.mcp-hub-modal-body { width: min(760px, 100%); max-height: 80vh; overflow: auto; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.mcp-hub-preset { display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.mcp-hub-preset-title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mcp-hub-rowline { display: flex; gap: 8px; align-items: center; }
`;

    /* ---------------------------------------------------------------- *
     * Small UI atoms
     * ---------------------------------------------------------------- */

    function Button({ children, onClick, disabled, variant, title }) {
      const cls = ['mcp-hub-btn'];
      if (variant === 'primary') cls.push('mcp-hub-btn-primary');
      if (variant === 'danger') cls.push('mcp-hub-btn-danger');
      return h('button', { type: 'button', className: cls.join(' '), onClick, disabled, title }, children);
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'mcp-hub-switch',
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'mcp-hub-knob' }),
      );
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'mcp-hub-field' }, h('span', { className: 'mcp-hub-label' }, label), children, hint ? h('span', { className: 'mcp-hub-hint' }, hint) : null);
    }

    function TextInput(props) {
      return h('input', { ...props, className: 'mcp-hub-input' });
    }

    function Note({ children, tone }) {
      const cls = ['mcp-hub-note'];
      if (tone === 'ok') cls.push('mcp-hub-note-ok');
      if (tone === 'error') cls.push('mcp-hub-note-error');
      return h('div', { className: cls.join(' ') }, children);
    }

    /** Unwrap the gateway's `{ok, value | error}` result into a promise. */
    async function unwrap(promise) {
      const result = await promise;
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) return result.value;
        const error = result.error;
        throw new Error(error === undefined || error === null ? 'remote call failed' : error.message ?? String(error));
      }
      return result;
    }

    /* ---------------------------------------------------------------- *
     * Editor
     * ---------------------------------------------------------------- */

    const BLANK = {
      id: undefined,
      name: '',
      transport: 'sse',
      description: '',
      url: '',
      command: '',
      args: '',
      cwd: '',
      env: '',
      headers: '',
      toolCallTimeoutMs: 60000,
      reconnectEnabled: true,
      enabled: true,
    };

    /** Turn a registry record into editor form values. */
    function toDraft(server) {
      if (server === undefined || server === null) return { ...BLANK };
      return {
        id: server.id,
        name: server.name ?? '',
        transport: server.transport ?? 'sse',
        description: server.description ?? '',
        url: server.url ?? '',
        command: server.command ?? '',
        args: Array.isArray(server.args) ? server.args.join(' ') : (server.args ?? ''),
        cwd: server.cwd ?? '',
        env: server.env === undefined ? '' : JSON.stringify(server.env, null, 2),
        headers: server.headers === undefined ? '' : JSON.stringify(server.headers, null, 2),
        toolCallTimeoutMs: server.toolCallTimeoutMs ?? 60000,
        reconnectEnabled: server.reconnect?.enabled !== false,
        enabled: server.enabled !== false,
      };
    }

    /** Turn editor form values back into the Host's server record. */
    function fromDraft(draft) {
      return {
        id: draft.id,
        name: draft.name.trim(),
        transport: draft.transport,
        description: draft.description,
        url: draft.url.trim(),
        command: draft.command.trim(),
        args: draft.args,
        cwd: draft.cwd.trim(),
        env: draft.env,
        headers: draft.headers,
        toolCallTimeoutMs: Number(draft.toolCallTimeoutMs) || 60000,
        enabled: draft.enabled,
        reconnect: { enabled: draft.reconnectEnabled },
      };
    }

    function Editor({ t, draft, onDraft, onSave, onCancel, onTest, busy, testResult }) {
      const set = (key) => (event) => onDraft({ ...draft, [key]: event.target.value });
      const isHttp = draft.transport === 'sse' || draft.transport === 'streamable-http';
      return h(
        'div',
        { className: 'mcp-hub-form' },
        h('div', { className: 'mcp-hub-title' }, draft.id === undefined ? t('editorNew') : t('editorEdit')),
        h(
          'div',
          { className: 'mcp-hub-grid' },
          h(Field, { label: t('fieldName'), hint: t('fieldNameHint') }, h(TextInput, { value: draft.name, onChange: set('name'), spellCheck: false })),
          h(
            Field,
            { label: t('fieldTransport') },
            h(
              'select',
              { className: 'mcp-hub-select', value: draft.transport, onChange: set('transport') },
              h('option', { value: 'stdio' }, t('transport_stdio')),
              h('option', { value: 'streamable-http' }, t('transport_streamableHttp')),
              h('option', { value: 'sse' }, t('transport_sse')),
            ),
          ),
        ),
        isHttp
          ? h(Field, { label: t('fieldUrl'), hint: t('fieldUrlHint') }, h(TextInput, { value: draft.url, onChange: set('url'), spellCheck: false }))
          : h(
              'div',
              { className: 'mcp-hub-grid' },
              h(Field, { label: t('fieldCommand') }, h(TextInput, { value: draft.command, onChange: set('command'), spellCheck: false })),
              h(Field, { label: t('fieldArgs') }, h(TextInput, { value: draft.args, onChange: set('args'), spellCheck: false })),
            ),
        isHttp
          ? h(
              'div',
              { className: 'mcp-hub-grid' },
              h(Field, { label: t('fieldHeaders') }, h('textarea', { className: 'mcp-hub-textarea', value: draft.headers, onChange: set('headers'), spellCheck: false, placeholder: '{\n  "Authorization": "Bearer ..."\n}' })),
              h(Field, { label: t('fieldDescription') }, h(TextInput, { value: draft.description, onChange: set('description') })),
            )
          : h(
              'div',
              { className: 'mcp-hub-grid' },
              h(Field, { label: t('fieldCwd') }, h(TextInput, { value: draft.cwd, onChange: set('cwd'), spellCheck: false })),
              h(Field, { label: t('fieldEnv') }, h('textarea', { className: 'mcp-hub-textarea', value: draft.env, onChange: set('env'), spellCheck: false, placeholder: '{\n  "TOKEN": "..."\n}' })),
              h(Field, { label: t('fieldDescription') }, h(TextInput, { value: draft.description, onChange: set('description') })),
            ),
        h(
          'div',
          { className: 'mcp-hub-grid' },
          h(Field, { label: t('fieldTimeout') }, h(TextInput, { type: 'number', min: 1000, step: 1000, value: draft.toolCallTimeoutMs, onChange: set('toolCallTimeoutMs') })),
          h(
            'div',
            { className: 'mcp-hub-field' },
            h('span', { className: 'mcp-hub-label' }, t('fieldReconnect')),
            h('div', { className: 'mcp-hub-rowline' }, h(Switch, { checked: draft.reconnectEnabled, onChange: (value) => onDraft({ ...draft, reconnectEnabled: value }), label: t('fieldReconnect') })),
          ),
        ),
        testResult === undefined || testResult === null
          ? null
          : h(Note, { tone: testResult.ok === true ? 'ok' : 'error' }, testResult.ok === true ? `${t('testOk')} · ${testResult.elapsedMs} ms · ${testResult.tools.length} ${t('colTools')}` : `${t('testFail')}: ${testResult.error}`),
        h(
          'div',
          { className: 'mcp-hub-actions' },
          h(Button, { variant: 'primary', onClick: onSave, disabled: busy === true }, busy === true ? t('saving') : t('save')),
          h(Button, { onClick: onTest, disabled: busy === true }, busy === true ? t('testing') : t('testDraft')),
          h(Button, { onClick: onCancel }, t('cancel')),
        ),
      );
    }

    /* ---------------------------------------------------------------- *
     * The settings page
     * ---------------------------------------------------------------- */

    function McpHubSection({ api, t, mountError }) {
      const [view, setView] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [expanded, setExpanded] = useState('');
      const [editor, setEditor] = useState(null);
      const [testResult, setTestResult] = useState(null);
      const [call, setCall] = useState(null);
      const [importer, setImporter] = useState(null);
      const [exporter, setExporter] = useState(null);
      const [copied, setCopied] = useState(false);
      const alive = useRef(true);

      const refresh = useCallback(async () => {
        try {
          const next = await unwrap(api.state());
          if (alive.current) {
            setView(next);
            setError('');
          }
        } catch (failure) {
          if (alive.current) setError(failure.message ?? String(failure));
        }
      }, [api]);

      useEffect(() => {
        alive.current = true;
        if (api === undefined) return () => {};
        refresh();
        /* Presence ping: lets `mcp_hub list` report whether this page is loaded
           and able to reach the Host service. Failures are not user-facing. */
        const beat = () => {
          unwrap(api.heartbeat()).catch(() => {});
        };
        beat();
        const timer = setInterval(() => {
          refresh();
          beat();
        }, 2500);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [api, refresh]);

      /** Run a mutating call, surfacing failures in the banner. */
      const mutate = useCallback(
        async (operation) => {
          setBusy(true);
          try {
            const next = await operation();
            if (next !== undefined && next !== null && alive.current) setView(next);
            setError('');
          } catch (failure) {
            if (alive.current) setError(failure.message ?? String(failure));
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [],
      );

      const servers = view?.servers ?? [];

      const onSave = useCallback(() => {
        if (editor === null) return;
        if (editor.name.trim() === '') {
          setError(t('fieldName'));
          return;
        }
        mutate(async () => {
          const next = await unwrap(api.upsert({ server: fromDraft(editor) }));
          if (alive.current) {
            setEditor(null);
            setTestResult(null);
          }
          return next;
        });
      }, [api, editor, mutate, t]);

      const onTestDraft = useCallback(() => {
        if (editor === null) return;
        setBusy(true);
        setTestResult(null);
        unwrap(api.test({ server: fromDraft(editor) }))
          .then((report) => {
            if (alive.current) setTestResult(report);
          })
          .catch((failure) => {
            if (alive.current) setTestResult({ ok: false, error: failure.message ?? String(failure) });
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      }, [api, editor]);

      const statusLabel = (server) => {
        const state = server.enabled ? server.status?.state ?? 'idle' : 'disabled';
        return t(`state_${state}`);
      };

      const dotClass = (server) => {
        const state = server.enabled ? server.status?.state ?? 'idle' : 'idle';
        return `mcp-hub-dot mcp-hub-dot-${state}`;
      };

      const header = h(
        'div',
        { className: 'mcp-hub-head' },
        h('div', { className: 'mcp-hub-title' }, t('title')),
        h('div', { className: 'mcp-hub-sub' }, t('subtitle')),
        view === null ? null : h('div', { className: 'mcp-hub-path' }, `${t('registry')}: ${view.file}`),
      );

      const toolbar = h(
        'div',
        { className: 'mcp-hub-bar' },
        h(
          Button,
          {
            variant: 'primary',
            onClick: () => {
              setEditor({ ...BLANK });
              setTestResult(null);
            },
          },
          t('add'),
        ),
        h(
          'select',
          {
            className: 'mcp-hub-select',
            style: { width: 'auto' },
            value: '',
            onChange: (event) => {
              const id = event.target.value;
              event.target.value = '';
              if (id !== '') mutate(() => unwrap(api.applyPreset({ preset: id })));
            },
          },
          [h('option', { value: '', key: '__p' }, `${t('presets')}…`)].concat(
            (view?.presets ?? []).map((preset) => h('option', { value: preset.id, key: preset.id }, preset.label)),
          ),
        ),
        h(Button, { onClick: () => setImporter({ text: '' }) }, t('import')),
        h(
          Button,
          {
            onClick: () => {
              setBusy(true);
              unwrap(api.exportJson())
                .then((result) => {
                  if (alive.current) setExporter({ text: result.text });
                })
                .catch((failure) => {
                  if (alive.current) setError(failure.message ?? String(failure));
                })
                .finally(() => {
                  if (alive.current) setBusy(false);
                });
            },
          },
          t('export'),
        ),
        h('div', { className: 'mcp-hub-spacer' }),
        servers.some((server) => server.status?.error) ? h(Button, { onClick: () => mutate(() => unwrap(api.clearErrors())) }, t('clearErrors')) : null,
        h(Button, { onClick: refresh, disabled: busy === true }, t('refresh')),
      );

      const rows = servers.map((server) => {
        const target = server.transport === 'stdio' ? [server.command].concat(server.args ?? []).join(' ') : server.url;
        const status = server.status ?? {};
        const open = expanded === server.id;
        const calls = call !== null && call.id === server.id ? call : null;
        return h(
          'div',
          { className: 'mcp-hub-card', key: server.id },
          h(
            'div',
            { className: 'mcp-hub-row' },
            h('span', { className: dotClass(server) }),
            h(
              'div',
              { className: 'mcp-hub-row-main' },
              h(
                'div',
                { className: 'mcp-hub-name' },
                server.name,
                h('span', { className: `mcp-hub-badge${server.transport === 'sse' ? ' mcp-hub-badge-sse' : ''}` }, server.transport),
                server.source !== 'manual' ? h('span', { className: 'mcp-hub-badge' }, server.source) : null,
              ),
              h('div', { className: 'mcp-hub-target' }, target === '' ? '—' : target),
              server.description ? h('div', { className: 'mcp-hub-hint' }, server.description) : null,
              status.error ? h('div', { className: 'mcp-hub-error' }, status.error) : null,
            ),
            h(
              'div',
              { className: 'mcp-hub-status' },
              statusLabel(server),
              server.enabled ? h('span', { className: 'mcp-hub-badge' }, t('toolsCount')(status.toolCount ?? 0)) : null,
            ),
            h(Switch, {
              checked: server.enabled !== false,
              label: server.name,
              onChange: (value) => mutate(() => unwrap(api.toggle({ id: server.id, enabled: value }))),
            }),
            h(
              'div',
              { className: 'mcp-hub-actions' },
              h(
                Button,
                {
                  onClick: () => {
                    setExpanded(open ? '' : server.id);
                    setCall(null);
                  },
                },
                open ? '▾' : '▸',
              ),
              h(
                Button,
                {
                  onClick: () => {
                    setEditor(toDraft(server));
                    setTestResult(null);
                  },
                },
                t('edit'),
              ),
              h(Button, { onClick: () => mutate(() => unwrap(api.reload({ id: server.id }))), disabled: busy === true }, t('reconnect')),
              h(
                Button,
                {
                  variant: 'danger',
                  onClick: () => {
                    if (window.confirm(t('confirmRemove'))) mutate(() => unwrap(api.removeServer({ id: server.id })));
                  },
                },
                t('remove'),
              ),
            ),
          ),
          open
            ? h(
                'div',
                { className: 'mcp-hub-detail' },
                (status.tools ?? []).length === 0
                  ? h('div', { className: 'mcp-hub-hint' }, t('noTools'))
                  : h(
                      'div',
                      { className: 'mcp-hub-tools' },
                      (status.tools ?? []).map((tool) =>
                        h(
                          'div',
                          { className: 'mcp-hub-tool', key: tool.name },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'mcp-hub-tool-name',
                              onClick: () => setCall({ id: server.id, tool: tool.name, args: '{}', result: null, running: false }),
                            },
                            tool.publicName,
                          ),
                          h('span', { className: 'mcp-hub-tool-desc' }, tool.description ?? ''),
                        ),
                      ),
                    ),
                status.serverInfo
                  ? h('div', { className: 'mcp-hub-hint' }, `${t('serverInfo')}: ${status.serverInfo.name} v${status.serverInfo.version} · ${t('protocol')}: ${status.protocolVersion ?? '?'}`)
                  : null,
                status.instructions ? h('pre', { className: 'mcp-hub-pre' }, status.instructions) : null,
                calls === null
                  ? null
                  : h(
                      'div',
                      { className: 'mcp-hub-form' },
                      h('div', { className: 'mcp-hub-label' }, `${t('callTitle')}: ${calls.tool}`),
                      h('textarea', {
                        className: 'mcp-hub-textarea',
                        value: calls.args,
                        spellCheck: false,
                        onChange: (event) => setCall({ ...calls, args: event.target.value }),
                      }),
                      h(
                        'div',
                        { className: 'mcp-hub-actions' },
                        h(
                          Button,
                          {
                            variant: 'primary',
                            disabled: calls.running === true,
                            onClick: () => {
                              const next = { ...calls, running: true, result: null };
                              setCall(next);
                              unwrap(api.invoke({ id: server.id, tool: calls.tool, args: calls.args }))
                                .then((result) => {
                                  if (alive.current) setCall({ ...next, running: false, result });
                                })
                                .catch((failure) => {
                                  if (alive.current) setCall({ ...next, running: false, result: { ok: false, text: failure.message ?? String(failure) } });
                                });
                            },
                          },
                          calls.running === true ? t('callRunning') : t('callRun'),
                        ),
                        h(Button, { onClick: () => setCall(null) }, t('close')),
                      ),
                      calls.result === null
                        ? null
                        : h(Note, { tone: calls.result.ok === true ? 'ok' : 'error' }, `${calls.result.elapsedMs ?? 0} ms`),
                      calls.result === null ? null : h('pre', { className: 'mcp-hub-pre' }, calls.result.text ?? ''),
                    ),
              )
            : null,
        );
      });

      const modal = (title, content, onClose) =>
        h(
          'div',
          {
            className: 'mcp-hub-modal',
            onClick: (event) => {
              if (event.target === event.currentTarget) onClose();
            },
          },
          h(
            'div',
            { className: 'mcp-hub-modal-body' },
            h('div', { className: 'mcp-hub-title' }, title),
            content,
            h('div', { className: 'mcp-hub-actions' }, h(Button, { onClick: onClose }, t('close'))),
          ),
        );

      /* A page that cannot reach its Host half still renders, explaining why,
         instead of throwing inside the settings shell. Placed after every hook
         so the render-time hook order never depends on the remote's state. */
      if (api === undefined) {
        return h(
          'div',
          { className: 'mcp-hub-root' },
          h('div', { className: 'mcp-hub-title' }, t('title')),
          h(Note, { tone: 'error' }, mountError === '' || mountError === undefined ? t('mountMissing') : `${t('mountMissing')}: ${mountError}`),
        );
      }

      return h(
        'div',
        { className: 'mcp-hub-root' },
        header,
        toolbar,
        error === '' ? null : h(Note, { tone: 'error' }, error),
        view === null ? h('div', { className: 'mcp-hub-hint' }, t('loading')) : null,
        view !== null && servers.length === 0 ? h(Note, null, t('empty')) : null,
        h('div', { className: 'mcp-hub-list' }, rows),
        editor === null
          ? null
          : modal(
              editor.id === undefined ? t('editorNew') : t('editorEdit'),
              h(Editor, {
                t,
                draft: editor,
                onDraft: setEditor,
                onSave,
                onCancel: () => {
                  setEditor(null);
                  setTestResult(null);
                },
                onTest: onTestDraft,
                busy,
                testResult,
              }),
              () => {
                setEditor(null);
                setTestResult(null);
              },
            ),
        importer === null
          ? null
          : modal(
              t('importTitle'),
              h(
                'div',
                { className: 'mcp-hub-form' },
                h('div', { className: 'mcp-hub-hint' }, t('importHint')),
                h('textarea', {
                  className: 'mcp-hub-textarea',
                  style: { minHeight: '200px' },
                  spellCheck: false,
                  value: importer.text,
                  onChange: (event) => setImporter({ text: event.target.value }),
                  placeholder: '{\n  "mcpServers": {\n    "burp": { "type": "sse", "url": "http://127.0.0.1:9876/sse" }\n  }\n}',
                }),
                h(
                  'div',
                  { className: 'mcp-hub-actions' },
                  h(
                    Button,
                    {
                      variant: 'primary',
                      disabled: busy === true,
                      onClick: () =>
                        mutate(async () => {
                          const result = await unwrap(api.importJson({ text: importer.text }));
                          if (alive.current) setImporter(null);
                          return result.state;
                        }),
                    },
                    busy === true ? t('importing') : t('importRun'),
                  ),
                ),
              ),
              () => setImporter(null),
            ),
        exporter === null
          ? null
          : modal(
              t('exportTitle'),
              h(
                'div',
                { className: 'mcp-hub-form' },
                h('div', { className: 'mcp-hub-hint' }, t('exportHint')),
                h('textarea', { className: 'mcp-hub-textarea', style: { minHeight: '220px' }, readOnly: true, value: exporter.text }),
                h(
                  'div',
                  { className: 'mcp-hub-actions' },
                  h(
                    Button,
                    {
                      onClick: () => {
                        const clipboard = navigator.clipboard;
                        if (clipboard === undefined) {
                          setCopied(false);
                          return;
                        }
                        clipboard.writeText(exporter.text).then(
                          () => setCopied(true),
                          () => setCopied(false),
                        );
                      },
                    },
                    copied ? t('copied') : t('copy'),
                  ),
                ),
              ),
              () => {
                setExporter(null);
                setCopied(false);
              },
            ),
      );
    }

    /* ---------------------------------------------------------------- *
     * Client plugin body
     * ---------------------------------------------------------------- */

    const inject = ['slots', 'remote', 'locale'];

    async function apply(ctx) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      if (document.getElementById(STYLE_ID) === null) document.head.appendChild(style);
      ctx.effect(() => () => {
        style.remove();
      }, `${PKG}: styles`);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PKG}: dictionaries`);
      /* A failed mount must not remove the page: it degrades to an explanation,
         which is the only client-side signal this plugin can show without
         access to the browser console. */
      let mountError = '';
      try {
        await ctx.remote.$mount(REMOTE);
      } catch (failure) {
        mountError = failure?.message ?? String(failure);
      }
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-hub',
            order: 26,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ api: ctx.get('remote.mcpHub'), mountError }),
          },
          McpHubSection,
        ),
      );
    }

    return { inject, apply };
  },
});
