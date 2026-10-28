/**
 * dsh-mcp-hub — Host half.
 *
 * Owns a durable registry of MCP servers and one live connection per enabled
 * server, and bridges each server's tools onto `ctx.tools` under the stable
 * `mcp__<serverName>__<rawName>` naming contract the shipped
 * `@deepseek-ai/dsh-mcp-client` established.
 *
 * Why this plugin exists instead of a configuration-only MCP bundle: the
 * shipped client's transport factory is a closed `switch` over
 * `stdio | streamable-http`. Servers that speak the legacy HTTP+SSE transport
 * (Burp Suite's MCP extension, Yakit) cannot be reached through it at all, so
 * this plugin owns its own transport factory and adds `sse` via the SDK's
 * `SSEClientTransport`, while reusing the shipped `createMcpToolDefinition()`
 * bridge for canonical results, error surfacing and durable image projection.
 *
 * Registry: `$DSH_HOME/mcp-hub/servers.json` (atomic publish).
 * Settings page: registered by the Client half through the `mcpHub` namespace.
 *
 * @module dsh-mcp-hub
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Stable Cordis plugin name. */
export const name = 'mcp-hub';
/** The tool registry is the one hard dependency. */
export const inject = ['tools'];

/** Namespace grammar shared with the shipped MCP client. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** Wire-protocol constant, not configuration. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars appended when normalization is lossy. */
const HASH_LENGTH = 12;
/** Default per-call timeout for `tools/call`. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
/**
 * How long one connect attempt may take.
 *
 * Only `tools/call` was ever bounded, so a server that accepted the socket and
 * then never answered `initialize` stayed `connecting` forever — no error, no
 * reconnect, nothing for the user to act on.
 */
const CONNECT_TIMEOUT_MS = 20_000;
/** Reconnect policy defaults, matching the shipped client's defaults. */
const RECONNECT_DEFAULTS = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
};
/** Transports this plugin can drive. */
const TRANSPORTS = ['stdio', 'streamable-http', 'sse'];
/** Registry document version. */
const STATE_VERSION = 1;
/** Env names dropped before spawning a stdio server (credential-shaped + stale DSH state). */
const SCRUBBED_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;
/** Prototype property name the Typert gateway reads Remote markers from. */
const REMOTE_MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods';
/**
 * Every method the settings page may call, in declaration order.
 *
 * Names must avoid the gateway's `RemoteNamespaceService` surface, which the
 * Client refuses to shadow: the reserved fields are `ctx`, `empty`,
 * `invokeRemote`, `methods`, `name`, `namespace`, and the prototype members
 * `empty`, `has`, `install`, `installDirect`, `installScoped`, `remove`.
 * `remove` is why deletion is spelled `removeServer` here.
 */
const REMOTE_METHODS = [
  'state',
  'heartbeat',
  'upsert',
  'removeServer',
  'toggle',
  'reload',
  'test',
  'invoke',
  'importJson',
  'exportJson',
  'applyPreset',
  'clearErrors',
];

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Strip `undefined` recursively so every Remote result is lossless JSON. */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = jsonSafe(entry);
    return out;
  }
  return value;
}

/** One human-readable line for an unknown thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The subprocess environment for a stdio server: scrubbed parent env plus explicit values. */
function buildChildEnv(extra) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SCRUBBED_ENV.test(key)) continue;
    if (key.startsWith('DSH_')) continue;
    base[key] = value;
  }
  return { ...base, ...(extra ?? {}) };
}

/** Derive the model-facing public tool name for one MCP tool. */
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** Coerce a value the UI sends as either a JSON text or an object into a string map. */
function stringMap(value) {
  const out = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    out[String(key)] = typeof entry === 'string' ? entry : String(entry);
  }
  return out;
}

/**
 * Coerce a value that may arrive as a JSON text or as an object — the settings
 * editor sends `headers`/`env` as text — without ever throwing, so loading a
 * hand-edited file can never fail the boot.
 */
function stringMapLoose(value) {
  if (typeof value !== 'string') return stringMap(value);
  const text = value.trim();
  if (text === '') return {};
  try {
    return stringMap(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Accept `{a:1}`, a JSON string, or nothing; reject anything else. */
function coerceMap(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label} must be a JSON object`);
    }
    return stringMap(parsed);
  }
  if (typeof value === 'object' && !Array.isArray(value)) return stringMap(value);
  throw new Error(`${label} must be a JSON object`);
}

/** Split a command line for the simple cases this UI needs (quotes honored). */
function splitCommandLine(line) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(line);
  while (match !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
    match = pattern.exec(line);
  }
  return parts;
}

/** A finite non-negative number, else the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * Durable registry
 * ------------------------------------------------------------------ */

/** Absolute path of the registry file for a resolved dsh home. */
export function registryFile(dshHome = resolveDshHome()) {
  return join(dshHome, 'mcp-hub', 'servers.json');
}

/**
 * Resolve the transport of an incoming record.
 *
 * Accepts this plugin's own `transport`, and the `type` spelling every other
 * MCP client uses (`stdio` / `http` / `sse`, as in Claude Code, Cursor,
 * Gemini CLI and cc-switch). `http` is the alias for Streamable HTTP; a bare
 * `url` with no discriminator is treated as Streamable HTTP, which is the
 * only safe guess because SSE servers always declare themselves.
 *
 * @param raw - candidate record from disk, import, or the settings page.
 * @returns one of {@link TRANSPORTS}.
 */
function resolveTransport(raw) {
  if (TRANSPORTS.includes(raw.transport)) return raw.transport;
  const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  if (declared === 'http' || declared === 'streamable-http' || declared === 'streamablehttp') return 'streamable-http';
  if (declared === 'sse') return 'sse';
  if (declared === 'stdio') return 'stdio';
  return raw.url !== undefined && String(raw.url) !== '' ? 'streamable-http' : 'stdio';
}

/**
 * Normalize one stored server record.
 * @param raw - candidate record from disk, import, or the settings page.
 * @param index - position, used for a fallback name.
 * @returns the canonical record, or undefined for a non-object.
 */
function normalizeServer(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const transport = resolveTransport(raw);
  const fallbackName = `server${index + 1}`;
  const rawName = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : fallbackName;
  const serverName = SERVER_NAME_PATTERN.test(rawName)
    ? rawName
    : rawName.replace(INVALID_NAME_CHARS, '-').slice(0, 32) || fallbackName;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : serverName;
  const args = Array.isArray(raw.args)
    ? raw.args.map((entry) => String(entry))
    : typeof raw.args === 'string' && raw.args.trim() !== ''
      ? splitCommandLine(raw.args)
      : [];
  const reconnect = raw.reconnect !== null && typeof raw.reconnect === 'object' ? raw.reconnect : {};
  return {
    id,
    name: serverName,
    enabled: raw.enabled !== false,
    transport,
    description: typeof raw.description === 'string' ? raw.description : '',
    source: typeof raw.source === 'string' ? raw.source : 'manual',
    command: typeof raw.command === 'string' ? raw.command : '',
    args,
    env: stringMapLoose(raw.env),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    headers: stringMapLoose(raw.headers),
    toolCallTimeoutMs:
      typeof raw.toolCallTimeoutMs === 'number' && Number.isFinite(raw.toolCallTimeoutMs) && raw.toolCallTimeoutMs > 0
        ? Math.min(raw.toolCallTimeoutMs, 600_000)
        : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: {
      enabled: reconnect.enabled !== false,
      initialDelayMs: numberOr(reconnect.initialDelayMs, RECONNECT_DEFAULTS.initialDelayMs),
      maxDelayMs: numberOr(reconnect.maxDelayMs, RECONNECT_DEFAULTS.maxDelayMs),
      maxAttempts: numberOr(reconnect.maxAttempts, RECONNECT_DEFAULTS.maxAttempts),
    },
  };
}

/**
 * Read the registry.
 *
 * A missing file is normal (first run). An unreadable or malformed one is
 * reported rather than silently treated as empty: the first later write would
 * otherwise rename a fresh document over it and the user would lose every
 * server with no trace of what happened.
 */
async function readRegistry(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { version: STATE_VERSION, servers: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      version: STATE_VERSION,
      servers: [],
      unreadable: error instanceof Error ? error.message : String(error),
    };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.servers) ? parsed.servers : [];
  const servers = [];
  list.forEach((entry, index) => {
    const normalized = normalizeServer(entry, index);
    if (normalized !== undefined) servers.push(normalized);
  });
  return { version: STATE_VERSION, servers };
}

/** Distinguishes overlapping writes that begin inside the same millisecond. */
let writeSequence = 0;

/** Atomic publish: write a unique temp sibling, then rename over the target. */
async function writeRegistry(file, servers) {
  await mkdir(dirname(file), { recursive: true });
  writeSequence += 1;
  const tmp = join(dirname(file), `.servers.${process.pid}.${Date.now().toString(36)}.${writeSequence.toString(36)}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ version: STATE_VERSION, servers }, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * Keep a copy of a registry document this build could not parse, so the first
 * write over it cannot destroy the user's servers.
 *
 * @param file - the unreadable registry.
 * @returns the backup path.
 */
async function preserveUnreadable(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}`;
  await copyFile(file, backup);
  return backup;
}

/* ------------------------------------------------------------------ *
 * Transport factory — the reason this plugin exists
 * ------------------------------------------------------------------ */

/**
 * Build an MCP transport for one server record.
 *
 * `sse` uses the SDK's legacy HTTP+SSE client transport: the client opens a GET
 * event stream, learns its POST endpoint from the server's `endpoint` event,
 * and receives every JSON-RPC message back over that same stream — the shape
 * Burp Suite's MCP extension and Yakit expose.
 *
 * @param server - normalized server record supplying defaults.
 * @param draft - optional unsaved values from the settings page that win over it.
 * @returns a connect-ready SDK transport.
 */
function buildTransport(server, draft = {}) {
  const transport = draft.transport ?? server.transport;
  switch (transport) {
    case 'stdio': {
      const command = String(draft.command ?? server.command).trim();
      if (command === '') throw new Error('stdio transport requires a command');
      const args = draft.args !== undefined ? draft.args : server.args;
      return new StdioClientTransport({
        command,
        args: Array.isArray(args) ? args.map(String) : splitCommandLine(String(args ?? '')),
        env: buildChildEnv(coerceMap(draft.env ?? server.env, 'env')),
        cwd: String(draft.cwd ?? server.cwd) || undefined,
      });
    }
    case 'streamable-http': {
      const url = String(draft.url ?? server.url).trim();
      if (url === '') throw new Error('streamable-http transport requires a url');
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: coerceMap(draft.headers ?? server.headers, 'headers') },
      });
    }
    case 'sse': {
      const url = String(draft.url ?? server.url).trim();
      if (url === '') throw new Error('sse transport requires a url');
      const headers = coerceMap(draft.headers ?? server.headers, 'headers');
      return new SSEClientTransport(new URL(url), {
        requestInit: { headers },
        eventSourceInit: { headers },
      });
    }
    default:
      throw new Error(`unsupported transport ${JSON.stringify(String(transport))}`);
  }
}

/** Close a client, swallowing the "already closed" family of failures. */
async function closeQuietly(client) {
  if (client === undefined) return;
  try {
    await client.close();
  } catch {
    /* a transport that is already gone is the expected outcome here */
  }
}

/* ------------------------------------------------------------------ *
 * One live server connection
 * ------------------------------------------------------------------ */

/** Supervision state of one configured server. */
class ServerRuntime {
  /**
   * @param hub - owning service (registration context, logger, change fan-out).
   * @param server - normalized server record.
   */
  constructor(hub, server) {
    this.hub = hub;
    this.server = server;
    this.client = undefined;
    this.disposers = new Map();
    this.state = 'idle';
    this.error = undefined;
    this.tools = [];
    this.instructions = '';
    this.serverInfo = undefined;
    this.protocolVersion = undefined;
    this.connectedAt = undefined;
    this.failedAttempts = 0;
    this.reconnectTimer = undefined;
    this.attempting = false;
    this.disposed = false;
    this.generation = 0;
  }

  /** Human-readable label for logs. */
  get label() {
    return `mcp-hub(${this.server.name})`;
  }

  /** Connection status projected for the management UI. */
  status() {
    return jsonSafe({
      id: this.server.id,
      state: this.server.enabled ? this.state : 'disabled',
      error: this.error,
      toolCount: this.tools.length,
      tools: this.tools.map((tool) => ({
        name: tool.rawName,
        publicName: tool.publicName,
        description: tool.description,
      })),
      instructions: this.instructions,
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
      connectedAt: this.connectedAt,
      failedAttempts: this.failedAttempts,
      reconnectEnabled: this.server.reconnect.enabled,
    });
  }

  /** Start connecting; never rejects. */
  async start() {
    await this.attempt();
  }

  /**
   * One connection attempt with a fresh client+transport pair: the MCP SDK
   * binds a Protocol to one transport for life, so a reconnect never reuses one.
   */
  async attempt() {
    if (this.disposed || this.attempting) return;
    this.attempting = true;
    const generation = ++this.generation;
    this.state = 'connecting';
    this.error = undefined;
    /** Whether the attempt has handed control back to the supervisor. */
    let settled = false;
    /** Whether the transport reported closure at any point during the attempt. */
    let closed = false;
    const client = new Client(
      { name: 'dsh-mcp-hub', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              this.sync().catch((error) => {
                this.hub.log.warn(`${this.label}: tool re-sync failed: ${messageOf(error)}`);
              });
            },
          },
        },
      },
    );
    const isCurrent = () => !this.disposed && this.generation === generation;
    client.onclose = () => {
      closed = true;
      if (!isCurrent() || !settled) return;
      this.hub.log.warn(`${this.label}: connection closed`);
      this.teardownGeneration();
      this.scheduleReconnect();
    };
    client.onerror = (error) => {
      if (isCurrent()) this.hub.log.warn(`${this.label}: ${messageOf(error)}`);
    };
    try {
      await client.connect(buildTransport(this.server), { timeout: CONNECT_TIMEOUT_MS });
      if (closed || !isCurrent()) {
        settled = true;
        await closeQuietly(client);
        if (!closed) this.scheduleReconnect();
        return;
      }
      this.client = client;
      this.connectedAt = Date.now();
      this.failedAttempts = 0;
      this.state = 'connected';
      this.instructions = client.getInstructions()?.trimEnd() ?? '';
      const version = client.getServerVersion();
      this.serverInfo = version === undefined ? undefined : jsonSafe({ name: version.name, version: version.version });
      this.protocolVersion = client.getNegotiatedProtocolVersion();
      await this.sync();
      settled = true;
      if (closed) {
        this.teardownGeneration();
        this.scheduleReconnect();
        return;
      }
      this.hub.log.info(`${this.label}: connected — ${this.tools.length} tool(s)`);
    } catch (error) {
      settled = true;
      this.error = messageOf(error);
      this.state = 'error';
      this.hub.log.warn(`${this.label}: attempt failed: ${this.error}`);
      await closeQuietly(client);
      if (isCurrent()) this.scheduleReconnect();
    } finally {
      settled = true;
      this.attempting = false;
      this.hub.notify();
    }
  }

  /** Fetch the server's tool list and atomically swap the registered generation. */
  async sync() {
    const client = this.client;
    if (client === undefined || this.disposed) return;
    const capabilities = client.getServerCapabilities();
    const response =
      capabilities?.tools === undefined ? { tools: [] } : await client.listTools(undefined, { cacheMode: 'refresh' });
    const next = new Map();
    for (const tool of response.tools) {
      const toolName = publicToolName(this.server.name, tool.name);
      if (next.has(toolName)) throw new Error(`${this.label}: server listed tool ${JSON.stringify(tool.name)} twice`);
      next.set(toolName, tool);
    }
    const disposers = new Map();
    const entries = [];
    try {
      for (const [toolName, tool] of next) {
        const definition = createMcpToolDefinition(this.hub.root, {
          name: toolName,
          rawName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: (args, execution) =>
            client.callTool(
              { name: tool.name, arguments: args },
              { signal: execution.signal, timeout: this.server.toolCallTimeoutMs, toolDefinition: tool },
            ),
        });
        disposers.set(toolName, this.hub.root.tools.register(definition));
        entries.push({ rawName: tool.name, publicName: toolName, description: tool.description ?? '' });
      }
    } catch (error) {
      for (const dispose of disposers.values()) dispose();
      throw error;
    }
    for (const dispose of this.disposers.values()) dispose();
    this.disposers = disposers;
    this.tools = entries;
    this.hub.notify();
  }

  /** Drop the current client and its tool registrations without scheduling a retry. */
  teardownGeneration() {
    this.client = undefined;
    for (const dispose of this.disposers.values()) dispose();
    this.disposers = new Map();
    this.tools = [];
    this.instructions = '';
    this.serverInfo = undefined;
    this.protocolVersion = undefined;
    this.connectedAt = undefined;
  }

  /** Schedule the next reconnect with doubling backoff, bounded by the policy. */
  scheduleReconnect() {
    const policy = this.server.reconnect;
    if (this.disposed || !this.server.enabled || policy.enabled !== true) {
      this.state = this.state === 'connected' ? 'idle' : this.state;
      this.hub.notify();
      return;
    }
    if (this.failedAttempts >= policy.maxAttempts) {
      this.state = 'error';
      this.error = this.error ?? `gave up after ${policy.maxAttempts} failed reconnect attempts`;
      this.hub.log.error(`${this.label}: ${this.error}`);
      this.hub.notify();
      return;
    }
    const delay = Math.min(policy.initialDelayMs * 2 ** this.failedAttempts, policy.maxDelayMs);
    this.failedAttempts += 1;
    this.state = 'reconnecting';
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.attempt().catch(() => {});
    }, delay);
    this.reconnectTimer.unref?.();
    this.hub.notify();
  }

  /** Stop reconnecting and release the connection; safe to call twice. */
  async dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.teardownGeneration();
    await closeQuietly(client);
  }
}

/* ------------------------------------------------------------------ *
 * The `mcpHub` service (Remote namespace for the settings page)
 * ------------------------------------------------------------------ */

/** Install the Remote marker descriptor the gateway's source mode reads. */
function markRemoteMethods(klass, methods) {
  Object.defineProperty(klass.prototype, REMOTE_MARKER, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(
        methods.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })),
      ),
    }),
  });
}

/** Built-in presets, with the endpoints the upstream projects actually document. */
const PRESETS = [
  {
    id: 'burp',
    label: 'Burp Suite MCP (SSE)',
    description:
      'Burp 官方 MCP 扩展。SSE 流在根路径 http://127.0.0.1:9876/（不是 /sse），消息端点由服务端的 endpoint 事件给出并自带 sessionId。端口可在 Burp 的 MCP 标签页修改；只监听 localhost，非 localhost 的 Origin/浏览器 UA 会被 403。',
    server: {
      name: 'burp',
      transport: 'sse',
      url: 'http://127.0.0.1:9876',
      description: 'Burp Suite MCP（SSE，根路径）',
    },
  },
  {
    id: 'burp-stdio',
    label: 'Burp Suite MCP (stdio 代理)',
    description:
      'Burp 扩展自带的 mcp-proxy-all.jar 方式：把下面的 java 换成 Burp 内置运行时，把 jar 路径改成扩展写出的实际路径。适用于不支持 SSE 的客户端。',
    server: {
      name: 'burp-proxy',
      transport: 'stdio',
      command: 'java',
      args: '-jar C:\\path\\to\\mcp-proxy-all.jar --sse-url http://127.0.0.1:9876',
      description: 'Burp MCP stdio 代理（需自行改路径）',
    },
  },
  {
    id: 'yakit',
    label: 'Yakit / 自定义 SSE 服务端',
    description:
      '占位预设：Yakit 是否内置 MCP Server 未获官方文档证实（11434 是 Ollama 端口，不要照抄）。请在 Yakit 内确认 MCP 端点后，把 URL 改成实际地址再启用；任何旧版 HTTP+SSE 服务端也可以用这一条。',
    server: {
      name: 'yakit',
      transport: 'sse',
      url: '',
      enabled: false,
      description: '待填写：Yakit MCP 端点（请自行确认）',
    },
  },
];

/** The management service behind the `mcpHub` Remote namespace. */
class McpHub extends TypertRemoteService {
  /**
   * @param ctx - the plugin's registration context (owns `tools`).
   */
  constructor(ctx) {
    super(ctx, 'mcpHub');
    this.root = ctx;
    this.log = ctx.logger;
    this.file = registryFile();
    this.servers = [];
    /** @type {Map<string, ServerRuntime>} */
    this.runtimes = new Map();
    this.listeners = new Set();
    /* Presence of the settings page, so the agent-facing `list` can say whether
       the browser half is actually running without any console access. */
    this.lastClientSeen = 0;
    /* Set when servers.json exists but could not be parsed. The message reaches
       `state()` and the tool, and the file is copied aside before the first
       write so a typo cannot silently destroy every configured server. */
    this.registryError = undefined;
    /** @type {string | undefined} where the unreadable document was kept. */
    this.registryBackup = undefined;
    /* Serializes writes, so two overlapping mutations cannot interleave. */
    this.persistChain = Promise.resolve();
  }

  /** Load the registry and bring every enabled server up; never rejects. */
  async boot() {
    const registry = await readRegistry(this.file);
    this.servers = registry.servers;
    /* Every boot re-reads the file, so a fixed registry must also clear the old
       complaint instead of leaving it up until a restart or `clearErrors()`.
       The preserved-copy path is kept: it stays a useful fact about this run. */
    this.registryError = undefined;
    if (registry.unreadable !== undefined) {
      this.registryError = `${this.file} is not valid JSON (${registry.unreadable}) — configure nothing and fix it, or let the next write start over; the unreadable document is copied aside first`;
      const warn = typeof this.log.warn === 'function' ? this.log.warn.bind(this.log) : this.log.info.bind(this.log);
      warn(`mcp-hub: ${this.registryError}`);
    }
    this.log.info(`mcp-hub: ${this.servers.length} server(s) configured in ${this.file}`);
    for (const server of this.servers) {
      if (!server.enabled) continue;
      this.start(server).catch(() => {});
    }
  }

  /** Subscribe to internal change notifications. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publish a change to internal listeners. */
  notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a broken listener must not break the connection supervisor */
      }
    }
  }

  /** Start (or restart) the runtime for one server record. */
  async start(server) {
    await this.stop(server.id);
    const runtime = new ServerRuntime(this, server);
    this.runtimes.set(server.id, runtime);
    await runtime.start();
    return runtime;
  }

  /** Stop and forget the runtime for one id. */
  async stop(id) {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    this.runtimes.delete(id);
    await runtime.dispose();
  }

  /**
   * Persist the current server list.
   *
   * Writes are serialized because two overlapping Remote mutations used to
   * build the same temp name and could reject with ENOENT. A registry that
   * failed to load is copied aside first, so this write cannot destroy it
   * without leaving evidence.
   */
  async persist() {
    const run = async () => {
      if (this.registryError !== undefined && this.registryBackup === undefined) {
        try {
          this.registryBackup = await preserveUnreadable(this.file);
          this.log.info(`mcp-hub: unreadable registry preserved as ${this.registryBackup}`);
        } catch {
          /* Keep the flag: a later write can still preserve it. */
        }
      }
      await writeRegistry(this.file, this.servers);
    };
    const next = this.persistChain.then(run, run);
    this.persistChain = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  /** The record for one id, or a descriptive throw. */
  require(id) {
    const server = this.servers.find((entry) => entry.id === id);
    if (server === undefined) throw new Error(`unknown MCP server id ${JSON.stringify(String(id))}`);
    return server;
  }

  /* ---- Remote methods (source-mode descriptors: simple identifiers only) ---- */

  /** Full management view: every server plus its live status. */
  /**
   * Presence ping from the settings page.
   *
   * The page polls this alongside `state()`. It exists so the agent-facing
   * `mcp_hub` tool can report whether the browser half is loaded and able to
   * reach this Host service — the one client-side fact that is otherwise
   * invisible without access to the browser console.
   *
   * @returns the recorded timestamp.
   */
  async heartbeat() {
    this.lastClientSeen = Date.now();
    return jsonSafe({ at: this.lastClientSeen });
  }

  async state() {
    return jsonSafe({
      file: this.file,
      home: resolveDshHome(),
      transports: TRANSPORTS,
      presets: PRESETS,
      lastClientSeen: this.lastClientSeen,
      registryError: this.registryError,
      registryBackup: this.registryBackup,
      servers: this.servers.map((server) => {
        const runtime = this.runtimes.get(server.id);
        return {
          ...server,
          status:
            runtime === undefined
              ? { id: server.id, state: server.enabled ? 'idle' : 'disabled', toolCount: 0, tools: [] }
              : runtime.status(),
        };
      }),
    });
  }

  /**
   * Create or update one server, then reconnect it when enabled.
   * @param payload - `{ server }`; an existing `id` updates in place.
   */
  async upsert(payload) {
    const draft = payload?.server;
    if (draft === null || typeof draft !== 'object') throw new Error('upsert requires a server object');
    /* The settings editor sends `headers`/`env` as JSON text. Coerce them here so
       a valid map survives the save (the object-only path used to drop it, which
       made "Test connection" succeed and the saved server then fail) and a typo
       is reported instead of silently becoming an empty map. */
    const patch = { ...draft, headers: coerceMap(draft.headers, 'headers'), env: coerceMap(draft.env, 'env') };
    const index = this.servers.findIndex((entry) => entry.id === draft.id);
    const normalized = normalizeServer(patch, index < 0 ? this.servers.length : index);
    if (normalized === undefined) throw new Error('server record could not be normalized');
    const clash = this.servers.find((entry) => entry.name === normalized.name && entry.id !== normalized.id);
    if (clash !== undefined) {
      throw new Error(`server name ${JSON.stringify(normalized.name)} is already used by ${clash.id}`);
    }
    if (normalized.transport === 'stdio' && normalized.command === '') throw new Error('stdio transport requires a command');
    if (normalized.transport !== 'stdio' && normalized.url === '') {
      throw new Error(`${normalized.transport} transport requires a url`);
    }
    if (index < 0) this.servers = [...this.servers, normalized];
    else {
      const next = [...this.servers];
      next[index] = normalized;
      this.servers = next;
    }
    await this.persist();
    await this.stop(normalized.id);
    if (normalized.enabled) this.start(normalized).catch(() => {});
    return await this.state();
  }

  /**
   * Remove one server and release its connection.
   * @param payload - `{ id }`.
   */
  async removeServer(payload) {
    const id = String(payload?.id ?? '');
    this.require(id);
    await this.stop(id);
    this.servers = this.servers.filter((entry) => entry.id !== id);
    await this.persist();
    return await this.state();
  }

  /**
   * Enable or disable one server without deleting it.
   * @param payload - `{ id, enabled }`.
   */
  async toggle(payload) {
    const id = String(payload?.id ?? '');
    const enabled = payload?.enabled === true;
    const server = this.require(id);
    server.enabled = enabled;
    await this.persist();
    if (enabled) this.start(server).catch(() => {});
    else await this.stop(id);
    return await this.state();
  }

  /**
   * Reconnect one server in place.
   * @param payload - `{ id }`.
   */
  async reload(payload) {
    const server = this.require(String(payload?.id ?? ''));
    await this.stop(server.id);
    if (server.enabled) this.start(server).catch(() => {});
    return await this.state();
  }

  /**
   * Probe a transport without saving it: connect, read server identity and
   * tools, then close. A stored record may supply the defaults.
   * @param payload - `{ server }` draft record.
   */
  async test(payload) {
    const draft = payload?.server;
    if (draft === null || typeof draft !== 'object') throw new Error('test requires a server object');
    const stored = draft.id === undefined ? undefined : this.servers.find((entry) => entry.id === draft.id);
    const normalized = normalizeServer(stored === undefined ? draft : { ...stored, ...draft }, 0);
    if (normalized === undefined) throw new Error('server record could not be normalized');
    const started = Date.now();
    const client = new Client(
      { name: 'dsh-mcp-hub', version: '0.1.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(buildTransport(normalized, draft), { timeout: CONNECT_TIMEOUT_MS });
      const capabilities = client.getServerCapabilities();
      const listed =
        capabilities?.tools === undefined ? { tools: [] } : await client.listTools(undefined, { cacheMode: 'refresh' });
      const version = client.getServerVersion();
      return jsonSafe({
        ok: true,
        elapsedMs: Date.now() - started,
        protocolVersion: client.getNegotiatedProtocolVersion(),
        serverInfo: version === undefined ? undefined : { name: version.name, version: version.version },
        instructions: client.getInstructions()?.trimEnd() ?? '',
        capabilities: capabilities === undefined ? undefined : Object.keys(capabilities),
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          publicName: publicToolName(normalized.name, tool.name),
          description: tool.description ?? '',
        })),
      });
    } catch (error) {
      return jsonSafe({ ok: false, elapsedMs: Date.now() - started, error: messageOf(error) });
    } finally {
      await closeQuietly(client);
    }
  }

  /**
   * Call one tool on a connected server directly (the settings page's "试一试").
   * @param payload - `{ id, tool, args }`; `args` may be an object or JSON text.
   */
  async invoke(payload) {
    const id = String(payload?.id ?? '');
    const toolName = String(payload?.tool ?? '');
    if (toolName === '') throw new Error('invoke requires a tool name');
    const runtime = this.runtimes.get(id);
    if (runtime === undefined || runtime.client === undefined) {
      throw new Error(`MCP server ${JSON.stringify(id)} is not connected`);
    }
    let args = payload?.args ?? {};
    if (typeof args === 'string') {
      const text = args.trim();
      try {
        args = text === '' ? {} : JSON.parse(text);
      } catch {
        throw new Error('arguments must be valid JSON');
      }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('arguments must be a JSON object');
    }
    const started = Date.now();
    const signal = AbortSignal.timeout(runtime.server.toolCallTimeoutMs);
    const result = await runtime.client.callTool(
      { name: toolName, arguments: args },
      { signal, timeout: runtime.server.toolCallTimeoutMs },
    );
    const text = (result.content ?? [])
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'image') return `[image ${block.mimeType ?? ''}]`;
        if (block.type === 'resource') return `[resource ${block.resource?.uri ?? ''}]`;
        return `[${String(block.type)}]`;
      })
      .join('\n');
    return jsonSafe({
      ok: result.isError !== true,
      elapsedMs: Date.now() - started,
      text: text === '' ? '(empty result)' : text,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    });
  }

  /**
   * Import servers from a pasted document (`mcpServers` map, an array, or one record).
   * @param payload - `{ text }`.
   */
  async importJson(payload) {
    const text = String(payload?.text ?? '').trim();
    if (text === '') throw new Error('nothing to import');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid JSON: ${messageOf(error)}`);
    }
    const entries = collectImportEntries(parsed);
    if (entries.length === 0) {
      throw new Error('no server definition found (expected an `mcpServers` object, an array, or one server record)');
    }
    const touched = [];
    const skipped = [];
    for (const entry of entries) {
      const normalized = normalizeServer(entry, this.servers.length + touched.length);
      if (normalized === undefined) {
        skipped.push(`entry-${String(skipped.length + touched.length + 1)}`);
        continue;
      }
      /* A record that can never connect is reported instead of stored, so an
         import cannot leave a dead row the list keeps dialling. */
      if (normalized.transport === 'stdio' ? normalized.command === '' : normalized.url === '') {
        skipped.push(normalized.id);
        continue;
      }
      const index = this.servers.findIndex((server) => server.id === normalized.id || server.name === normalized.name);
      if (index < 0) this.servers = [...this.servers, normalized];
      else {
        const previous = this.servers[index];
        const next = [...this.servers];
        next[index] = {
          ...normalized,
          id: previous.id,
          source: previous.source,
          /* `mcpServers` has no `enabled` field, so importing must not silently
             switch a server the user had turned off back on. */
          enabled: entry !== null && typeof entry === 'object' && 'enabled' in entry ? normalized.enabled : previous.enabled,
        };
        this.servers = next;
      }
      touched.push(normalized.id);
    }
    await this.persist();
    for (const server of this.servers) {
      if (touched.includes(server.id) && server.enabled && !this.runtimes.has(server.id)) {
        this.start(server).catch(() => {});
      }
    }
    return jsonSafe({ imported: touched.length, ids: touched, skipped, state: await this.state() });
  }

  /** Export every server as a Claude/Cursor-compatible `mcpServers` document. */
  async exportJson() {
    const mcpServers = {};
    for (const server of this.servers) {
      mcpServers[server.name] =
        server.transport === 'stdio'
          ? {
              type: 'stdio',
              command: server.command,
              args: server.args,
              env: server.env,
              ...(server.cwd === '' ? {} : { cwd: server.cwd }),
            }
          : {
              /* `http` is the spelling Claude Code, Cursor and cc-switch use for
                 Streamable HTTP; `sse` is written verbatim. */
              type: server.transport === 'streamable-http' ? 'http' : 'sse',
              url: server.url,
              headers: server.headers,
            };
    }
    return jsonSafe({ text: JSON.stringify({ mcpServers }, null, 2), file: this.file });
  }

  /**
   * Merge one built-in preset into the registry.
   * @param payload - `{ preset }` with a preset id from `state()`.
   */
  async applyPreset(payload) {
    const preset = PRESETS.find((entry) => entry.id === String(payload?.preset ?? ''));
    if (preset === undefined) throw new Error(`unknown preset ${JSON.stringify(String(payload?.preset))}`);
    let name = preset.server.name;
    let suffix = 2;
    while (this.servers.some((server) => server.name === name)) name = `${preset.server.name}${suffix++}`;
    const normalized = normalizeServer(
      {
        ...preset.server,
        name,
        id: name,
        /* A preset may ship disabled on purpose — a placeholder endpoint the
           user has to fill in before it can connect. */
        enabled: preset.server.enabled !== false,
        source: `preset:${preset.id}`,
      },
      this.servers.length,
    );
    this.servers = [...this.servers, normalized];
    await this.persist();
    if (normalized.enabled) this.start(normalized).catch(() => {});
    return await this.state();
  }

  /** Clear stored error text so the list stops showing stale failures. */
  async clearErrors() {
    for (const runtime of this.runtimes.values()) {
      runtime.error = undefined;
      /* A failed attempt leaves `state: 'error'` behind; without this the row
         keeps a red dot with no reason until the next attempt. */
      if (runtime.state === 'error') runtime.state = 'idle';
    }
    this.registryError = undefined;
    return await this.state();
  }

  /** Release every connection and tool registration. */
  async dispose() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  }
}

markRemoteMethods(McpHub, REMOTE_METHODS);

/** Collect candidate server records out of an arbitrary imported document. */
function collectImportEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed === null || typeof parsed !== 'object') return [];
  if (parsed.mcpServers !== null && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
    return Object.entries(parsed.mcpServers).map(([key, value]) => ({ name: key, id: key, ...(value ?? {}) }));
  }
  if (Array.isArray(parsed.servers)) return parsed.servers;
  if (typeof parsed.command === 'string' || typeof parsed.url === 'string') return [parsed];
  return [];
}

/* ------------------------------------------------------------------ *
 * Agent-facing tool
 * ------------------------------------------------------------------ */

/**
 * Register one compact management tool so the model can inspect and drive the
 * same registry the settings page edits.
 * @param ctx - plugin context carrying `tools`.
 * @param hub - the management service.
 */
function registerHubTool(ctx, hub) {
  ctx.tools.register(
    defineTool({
      name: 'mcp_hub',
      description:
        'Manage the user\'s MCP servers (stdio / streamable-http / SSE). `list` shows configured servers with live status; `tools` lists one server\'s tools; `test` probes a server or a draft config without saving; `call` invokes one tool on a connected server; `add`, `import`, `remove`, `enable`, `disable` change the registry. SSE-only servers such as Burp Suite and Yakit are reachable only through this registry.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'tools', 'test', 'call', 'add', 'import', 'remove', 'enable', 'disable'],
          description: 'Operation to perform.',
        },
        id: { type: 'string', description: 'Server id (or name) for tools/test/call/remove/enable/disable.' },
        name: { type: 'string', description: 'Namespace for `add`; `[A-Za-z0-9_-]{1,32}`.' },
        transport: { type: 'string', enum: TRANSPORTS, description: 'Transport for `add`: stdio | streamable-http | sse.' },
        command: { type: 'string', description: 'Executable for transport=stdio.' },
        args: { type: 'string', description: 'Arguments for transport=stdio, space separated.' },
        url: { type: 'string', description: 'Endpoint for transport=streamable-http or sse.' },
        headers: { type: 'string', description: 'JSON object of extra request headers for http/sse.' },
        env: { type: 'string', description: 'JSON object of extra environment variables for stdio.' },
        text: {
          type: 'string',
          description:
            'JSON document for `import`: a Claude/Cursor `{"mcpServers":{...}}` map, an array of records, or one record.',
        },
        tool: { type: 'string', description: 'Raw tool name for `call`.' },
        toolArgs: { type: 'string', description: 'JSON object of arguments for `call`.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '(no result)') }],
      },
      async execute(args) {
        const action = String(args.action);
        const wanted = args.id === undefined ? undefined : String(args.id);
        const resolve = () => {
          if (wanted === undefined) throw new Error('`id` is required for this action');
          const server = hub.servers.find((entry) => entry.id === wanted || entry.name === wanted);
          if (server === undefined) throw new Error(`unknown MCP server ${JSON.stringify(wanted)}`);
          return server;
        };
        switch (action) {
          case 'list': {
            /* Read presence before `state()`, which is shared with the page. */
            const seen = hub.lastClientSeen;
            const view = await hub.state();
            const where = seen === 0 ? 'never (settings page not loaded)' : `${Math.round((Date.now() - seen) / 1000)}s ago`;
            const presence = `Settings page last seen: ${where}.`;
            /* A registry that could not be parsed is the one thing the agent
               must be able to report: everything the user configured is missing
               from this list, and the next write starts over. */
            const broken =
              view.registryError === undefined
                ? ''
                : `\nWARNING: ${view.registryError}${view.registryBackup === undefined ? '' : ` (kept as ${view.registryBackup})`}`;
            if (view.servers.length === 0) return { text: `No MCP servers configured. Registry: ${view.file}\n${presence}${broken}` };
            return {
              text: `MCP servers (${view.file}):${broken}\n${view.servers
                .map((server) => {
                  const status = server.status ?? {};
                  const target = server.transport === 'stdio' ? server.command : server.url;
                  const extra = [
                    status.toolCount ? `${status.toolCount} tools` : '',
                    status.error ? `error: ${status.error}` : '',
                  ]
                    .filter(Boolean)
                    .join('; ');
                  return `- ${server.name} [${server.transport}] ${server.enabled ? (status.state ?? 'idle') : 'disabled'} — ${target}${extra ? ` (${extra})` : ''}`;
                })
                .join('\n')}\n${presence}`,
            };
          }
          case 'tools': {
            const server = resolve();
            const runtime = hub.runtimes.get(server.id);
            if (runtime === undefined || runtime.client === undefined) {
              throw new Error(`MCP server ${JSON.stringify(server.name)} is not connected`);
            }
            if (runtime.tools.length === 0) return { text: `${server.name} exposes no tools.` };
            return {
              text: runtime.tools
                .map((tool) => `- ${tool.publicName} (raw: ${tool.rawName}) — ${tool.description}`)
                .join('\n'),
            };
          }
          case 'test': {
            const stored = wanted === undefined ? undefined : hub.servers.find((entry) => entry.id === wanted || entry.name === wanted);
            const draft =
              stored === undefined
                ? {
                    name: args.name,
                    transport: args.transport,
                    command: args.command,
                    args: args.args,
                    url: args.url,
                    headers: args.headers,
                    env: args.env,
                  }
                : {
                    ...stored,
                    ...(args.url === undefined ? {} : { url: args.url }),
                    ...(args.command === undefined ? {} : { command: args.command }),
                    ...(args.headers === undefined ? {} : { headers: args.headers }),
                  };
            const report = await hub.test({ server: draft });
            if (report.ok !== true) return { text: `Connection failed after ${report.elapsedMs} ms: ${report.error}` };
            const identity = report.serverInfo === undefined ? 'anonymous server' : `${report.serverInfo.name} v${report.serverInfo.version}`;
            const listed = report.tools.map((tool) => `- ${tool.publicName} (raw: ${tool.name})`).join('\n');
            return {
              text: `Connected in ${report.elapsedMs} ms — ${identity}, protocol ${report.protocolVersion ?? '?'}. ${report.tools.length} tool(s):\n${listed}`,
            };
          }
          case 'call': {
            const server = resolve();
            if (args.tool === undefined) throw new Error('`tool` is required for `call`');
            const result = await hub.invoke({ id: server.id, tool: String(args.tool), args: args.toolArgs ?? {} });
            return { text: result.text };
          }
          case 'add': {
            if (args.name === undefined) throw new Error('`name` is required for `add`');
            await hub.upsert({
              server: {
                id: wanted ?? args.name,
                name: args.name,
                transport: args.transport ?? 'stdio',
                command: args.command,
                args: args.args,
                url: args.url,
                headers: args.headers,
                env: args.env,
                enabled: true,
                source: 'agent',
              },
            });
            return { text: `Saved MCP server ${JSON.stringify(String(args.name))}.` };
          }
          case 'import': {
            if (args.text === undefined) throw new Error('`text` is required for `import`');
            const imported = await hub.importJson({ text: String(args.text) });
            const names = imported.state.servers.map((server) => server.name).join(', ');
            /* Skipped records have to be named: an import that quietly drops a
               server is indistinguishable from one that never contained it. */
            const dropped = imported.skipped.length === 0 ? '' : `\nSkipped ${String(imported.skipped.length)} record(s): ${imported.skipped.join(', ')}`;
            return { text: `Imported ${imported.imported} server(s): ${names}${dropped}` };
          }
          case 'remove': {
            const server = resolve();
            await hub.removeServer({ id: server.id });
            return { text: `Removed MCP server ${JSON.stringify(server.name)} and unregistered its tools.` };
          }
          case 'enable':
          case 'disable': {
            const server = resolve();
            await hub.toggle({ id: server.id, enabled: action === 'enable' });
            return { text: `${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${JSON.stringify(server.name)}.` };
          }
          default:
            throw new Error(`unsupported action ${JSON.stringify(action)}`);
        }
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Mount the management service, bring configured servers up in the background,
 * and register the agent-facing tool.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const hub = new McpHub(ctx);
  ctx.effect(() => () => hub.dispose(), 'mcp-hub: server connections');
  registerHubTool(ctx, hub);
  hub.boot().catch((error) => {
    ctx.logger.error(`mcp-hub: registry could not be loaded: ${messageOf(error)}`);
  });
}
