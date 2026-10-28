/**
 * Test double for `@modelcontextprotocol/client`.
 *
 * The plugin resolves the real MCP SDK from the DSH installation at runtime, so
 * a checkout of this package has nothing to import and no dependency may be
 * added. This double therefore implements the small slice of the client
 * protocol the plugin drives — JSON-RPC 2.0 `initialize` →
 * `notifications/initialized` → `tools/list` → `tools/call`, plus
 * `notifications/tools/list_changed` — on top of `node:` builtins only, so the
 * three transports really talk to the local fixtures over sockets and pipes:
 *
 *   - `StreamableHTTPClientTransport` POSTs JSON-RPC to one endpoint and reads a
 *     JSON body (or a per-request SSE stream), carrying `Mcp-Session-Id`
 *     (MCP 2025-03-26).
 *   - `SSEClientTransport` opens the legacy GET event stream, learns its POST
 *     endpoint from the server's `endpoint` event and reads every reply from
 *     that same stream (MCP 2024-11-05) — the shape Burp Suite and Yakit ship.
 *   - `StdioClientTransport` spawns a child and speaks newline-delimited
 *     JSON-RPC over its stdio pipes.
 *
 * Everything it observes is recorded on `__sdk`, which is how the suite proves
 * which transport the plugin built and with which values. Only `Client`,
 * `SSEClientTransport`, `StreamableHTTPClientTransport` and
 * `StdioClientTransport` are part of the plugin's contract; the rest exists to
 * make them work.
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';

/** What a suite can observe about the double. */
export const __sdk = {
  clients: [],
  transports: [],
  /** Forget everything recorded so far. */
  reset() {
    this.clients.length = 0;
    this.transports.length = 0;
  },
  /** The most recent transport of one kind, newest first. */
  latest(kind) {
    for (let index = this.transports.length - 1; index >= 0; index -= 1) {
      if (this.transports[index].kind === kind) return this.transports[index];
    }
    return undefined;
  },
  /** Every transport of one kind created since a `transports.length` mark. */
  since(kind, mark) {
    return this.transports.slice(mark).filter((entry) => entry.kind === kind);
  },
  /** Instances of one transport kind that were closed deliberately. */
  closedCount(kind) {
    return this.transports.filter((entry) => entry.kind === kind && entry.transport.closed === true).length;
  },
};

/** Lower-case a plain header map so comparisons are case-insensitive. */
function headerObject(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

/** Parse one SSE block (`event:` / `data:` lines) into `{ event, data }`. */
function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const index = line.indexOf(':');
    const field = index < 0 ? line : line.slice(0, index);
    const value = index < 0 ? '' : line.slice(index + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return { event, data: data.length === 0 ? undefined : data.join('\n') };
}

/**
 * A JSON-RPC 2.0 client over one transport.
 *
 * The plugin uses `onclose`/`onerror` callbacks, `connect`, `getInstructions`,
 * `getServerVersion`, `getServerCapabilities`, `getNegotiatedProtocolVersion`,
 * `listTools`, `callTool` and `close`.
 */
export class Client {
  constructor(info, options = {}) {
    this.info = info;
    this.options = options;
    this.transport = undefined;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.closing = false;
    this.instructions = undefined;
    this.serverVersion = undefined;
    this.capabilities = undefined;
    this.protocolVersion = undefined;
    __sdk.clients.push(this);
  }

  /** Feed one inbound JSON-RPC message to the waiting request or the notifier. */
  _dispatch(message) {
    if (message === null || typeof message !== 'object') return;
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      entry.settle();
      if (message.error !== undefined) {
        entry.reject(new Error(`${String(message.error.code)}: ${String(message.error.message)}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method === 'notifications/tools/list_changed') {
      this.options?.listChanged?.tools?.onChanged?.();
    }
  }

  /** Send one request and resolve with its result. */
  _request(method, params, options = {}) {
    const id = this.nextId++;
    const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 60_000;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, signal: options.signal, onAbort: undefined };
      entry.settle = () => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        if (entry.signal !== undefined && entry.onAbort !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        entry.settle();
        reject(new Error(`request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      entry.timer.unref?.();
      if (options.signal !== undefined) {
        entry.onAbort = () => {
          this.pending.delete(id);
          entry.settle();
          reject(new Error(`request ${method} aborted`));
        };
        if (options.signal.aborted) {
          entry.onAbort();
          return;
        }
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      Promise.resolve(this.transport.send({ jsonrpc: '2.0', id, method, params })).catch((error) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Send one notification (no reply expected). */
  _notify(method, params) {
    return Promise.resolve(this.transport.send({ jsonrpc: '2.0', method, params }));
  }

  async connect(transport) {
    this.transport = transport;
    transport.onmessage = (message) => this._dispatch(message);
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => {
      this.closed = true;
      this.onclose?.();
    };
    await transport.start();
    const result = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: this.info,
    });
    this.protocolVersion = result?.protocolVersion;
    this.capabilities = result?.capabilities ?? {};
    this.serverVersion = result?.serverInfo;
    this.instructions = result?.instructions;
    await this._notify('notifications/initialized', {});
  }

  getInstructions() {
    return this.instructions;
  }

  getServerVersion() {
    return this.serverVersion;
  }

  getServerCapabilities() {
    return this.capabilities;
  }

  getNegotiatedProtocolVersion() {
    return this.protocolVersion;
  }

  listTools() {
    return this._request('tools/list', {});
  }

  callTool(params, options = {}) {
    return this._request(
      'tools/call',
      { name: params?.name, arguments: params?.arguments ?? {} },
      { signal: options?.signal, timeout: options?.timeout },
    );
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.closed = true;
    try {
      await this.transport?.close?.();
    } catch {
      /* a transport that is already gone is the expected outcome here */
    }
  }
}

/**
 * MCP Streamable HTTP (2025-03-26): one endpoint, JSON-RPC over POST.
 * A reply is either a JSON body or a per-request SSE stream.
 */
export class StreamableHTTPClientTransport {
  constructor(url, options = {}) {
    this.url = new URL(url);
    this.headers = headerObject(options?.requestInit?.headers);
    this.sessionId = undefined;
    this.closed = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    __sdk.transports.push({ kind: 'streamable-http', url: this.url.href, headers: this.headers, transport: this });
  }

  /** Nothing to open: every message is its own request. */
  async start() {}

  _post(message) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(message);
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(payload)),
        ...this.headers,
      };
      if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
      const request = httpRequest(
        {
          hostname: this.url.hostname,
          port: this.url.port === '' ? 80 : Number(this.url.port),
          path: `${this.url.pathname}${this.url.search}`,
          method: 'POST',
          headers,
        },
        (response) => {
          const session = response.headers['mcp-session-id'];
          if (typeof session === 'string' && session !== '') this.sessionId = session;
          const status = response.statusCode ?? 0;
          const contentType = String(response.headers['content-type'] ?? '');
          response.on('error', (error) => {
            if (!this.closed) this.onerror?.(error);
            resolve();
          });
          if (contentType.includes('text/event-stream')) {
            let buffer = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              buffer += chunk;
              let boundary = buffer.indexOf('\n\n');
              while (boundary >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = parseSseBlock(block);
                if (event.data !== undefined) {
                  try {
                    this.onmessage?.(JSON.parse(event.data));
                  } catch {
                    /* a malformed frame is the server's problem, not the client's */
                  }
                }
                boundary = buffer.indexOf('\n\n');
              }
            });
            response.on('end', () => resolve());
            return;
          }
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (status >= 400) {
              reject(new Error(`HTTP ${status}: ${text.trim().slice(0, 200)}`));
              return;
            }
            if (text.trim() === '') {
              resolve();
              return;
            }
            try {
              this.onmessage?.(JSON.parse(text));
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', (error) => {
        if (this.closed) {
          resolve();
          return;
        }
        reject(error);
      });
      request.end(payload);
    });
  }

  async send(message) {
    if (this.closed) throw new Error('transport is closed');
    return this._post(message);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const session = this.sessionId;
    this.sessionId = undefined;
    if (session === undefined) return;
    await new Promise((resolve) => {
      const request = httpRequest(
        {
          hostname: this.url.hostname,
          port: this.url.port === '' ? 80 : Number(this.url.port),
          path: `${this.url.pathname}${this.url.search}`,
          method: 'DELETE',
          headers: { ...this.headers, 'mcp-session-id': session },
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
          response.on('error', resolve);
        },
      );
      request.on('error', () => resolve());
      request.end();
    });
  }
}

/**
 * Legacy MCP HTTP+SSE (2024-11-05): a GET event stream announces its POST
 * endpoint through an `endpoint` event; every reply arrives on the stream.
 */
export class SSEClientTransport {
  constructor(url, options = {}) {
    this.url = new URL(url);
    this.headers = {
      ...headerObject(options?.requestInit?.headers),
      ...headerObject(options?.eventSourceInit?.headers),
    };
    this.endpoint = undefined;
    this.request = undefined;
    this.closed = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    __sdk.transports.push({ kind: 'sse', url: this.url.href, headers: this.headers, transport: this });
  }

  /** Open the event stream; resolves once the server announced its endpoint. */
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const request = httpRequest(
        {
          hostname: this.url.hostname,
          port: this.url.port === '' ? 80 : Number(this.url.port),
          path: `${this.url.pathname}${this.url.search}`,
          method: 'GET',
          headers: { accept: 'text/event-stream', ...this.headers },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.resume();
            fail(new Error(`SSE stream refused with HTTP ${status}`));
            return;
          }
          this.request = request;
          let buffer = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            buffer += chunk;
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const event = parseSseBlock(block);
              if (event.event === 'endpoint' && event.data !== undefined) {
                try {
                  this.endpoint = new URL(event.data.trim(), this.url);
                } catch (error) {
                  fail(error);
                  return;
                }
                if (!settled) {
                  settled = true;
                  resolve();
                }
              } else if (event.data !== undefined) {
                try {
                  this.onmessage?.(JSON.parse(event.data));
                } catch {
                  /* ignore a malformed frame */
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          });
          response.on('error', (error) => {
            fail(error);
            if (settled && !this.closed) this.onerror?.(error);
          });
          response.on('end', () => {
            fail(new Error('SSE stream ended before the endpoint event'));
            if (settled && !this.closed) this.onclose?.();
          });
        },
      );
      request.on('error', (error) => {
        fail(error);
        if (settled && !this.closed) this.onerror?.(error);
      });
      request.end();
    });
  }

  /** POST one message to the announced endpoint; replies arrive on the stream. */
  send(message) {
    if (this.endpoint === undefined) throw new Error('the SSE transport has no message endpoint yet');
    const payload = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: this.endpoint.hostname,
          port: this.endpoint.port === '' ? 80 : Number(this.endpoint.port),
          path: `${this.endpoint.pathname}${this.endpoint.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(Buffer.byteLength(payload)),
            ...this.headers,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          response.on('error', reject);
          response.on('end', () => {
            if (status >= 400) reject(new Error(`HTTP ${status} posting to the SSE endpoint`));
            else resolve();
          });
        },
      );
      request.on('error', (error) => {
        if (this.closed) resolve();
        else reject(error);
      });
      request.end(payload);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const request = this.request;
    this.request = undefined;
    this.endpoint = undefined;
    request?.destroy();
  }
}

/**
 * stdio: newline-delimited JSON-RPC over a spawned child's stdio pipes.
 *
 * `spawn` is wrapped because a restricted environment can reject it outright
 * (a synchronous `EPERM` on Windows sandboxes), which has to surface as a
 * failed connection instead of an unhandled throw.
 */
export class StdioClientTransport {
  constructor(options = {}) {
    this.command = options?.command;
    this.args = Array.isArray(options?.args) ? options.args : [];
    this.env = options?.env;
    this.cwd = options?.cwd;
    this.child = undefined;
    this.buffer = '';
    this.closed = false;
    this.closing = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    __sdk.transports.push({
      kind: 'stdio',
      command: this.command,
      args: this.args,
      env: this.env,
      cwd: this.cwd,
      transport: this,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env,
          cwd: this.cwd === undefined || this.cwd === '' ? undefined : this.cwd,
          windowsHide: true,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      child.on('error', (error) => {
        fail(error);
        if (settled && !this.closing) this.onerror?.(error);
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      child.on('exit', () => {
        this.closed = true;
        fail(new Error('the stdio server exited before the handshake finished'));
        if (settled && !this.closing) this.onclose?.();
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        this.buffer += chunk;
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line !== '') {
            try {
              this.onmessage?.(JSON.parse(line));
            } catch {
              /* ignore a malformed frame */
            }
          }
          index = this.buffer.indexOf('\n');
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', () => {
        /* a fixture's stderr is noise here */
      });
    });
  }

  send(message) {
    if (this.child === undefined || this.child.stdin === null) {
      return Promise.reject(new Error('the stdio transport has no running child'));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) {
      child.stdin?.end();
      child.kill();
    }
  }
}
