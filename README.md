# dsh-mcp-hub

> 插件包名 **`mcp-tool`**（npm 上未被占用，可直接发布）；仓库名沿用 `dsh-mcp-hub`。

## 安装

```powershell
dsh plugin add mcp-tool
```

装完在 **设置 → MCP 管理** 里使用；也可以从仓库装：`dsh plugin add https://github.com/qingchuana/dsh-mcp-hub`。

在 DeepSeek Harness 的设置页集中管理 MCP 服务器，并把它们的工具按
`mcp__<名称>__<工具>` 注册给模型。

> 配套插件 **`dsh-skill-hub`**（技能管理）在另一个仓库：
> [github.com/qingchuana/dsh-skill-hub](https://github.com/qingchuana/dsh-skill-hub)。
> 两者互不依赖，可以只装其中一个。

## 为什么需要它

Harness 自带的 `@deepseek-ai/dsh-mcp-client` 只支持两种传输：

```js
// @deepseek-ai/dsh-mcp-client/lib/index.js
switch (transport) { case 'stdio': … case 'streamable-http': … }
```

**没有 `sse`。** 而 Burp Suite 官方的 MCP 扩展只提供旧版 HTTP+SSE
（`2024-11-05` 传输），Yakit 之类工具也走同一套机制，因此它们在原生配置里
根本连不上——即使写进 profile 的 patch 也一样。

本插件自己拥有传输工厂：`stdio` / `streamable-http` 与原实现一致，
新增 `sse` 走 SDK 的 `SSEClientTransport`；工具桥接仍复用官方导出的
`createMcpToolDefinition()`，所以结果封装、错误上报、图片投影的行为与原生一致。

## 安装

把本仓库克隆（或解压）到本地，然后在 DSH 里：

```
plugin_manager → install_bundle → target: <本仓库绝对路径>
```

安装后：设置 → **MCP 管理**（order 26）。

不需要 npm 安装任何依赖：Host 半边用到的 `@modelcontextprotocol/client`、
`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`、
`@deepseek-ai/dsh-typert-protocol` 全部由 DSH 宿主在运行时提供，浏览器半边的 `react`
同理（客户端模块加载器供给）。测试通过改写这些 specifier 为本地桩来脱离宿主运行。

> 修改本插件代码后需要**重启 DSH** 才会加载新的 Host 模块代；仅刷新页面只会更新
> 浏览器半边。

## 三种传输

| 传输 | 用途 | 目标写法 |
|---|---|---|
| `stdio` | 本地进程（官方 MCP server、代理 jar） | 命令 + 参数 + 环境变量 |
| `streamable-http` | 现代单端点 HTTP（`2025-03-26+`） | `http://host:port/mcp` |
| `sse` | 旧版 HTTP+SSE（Burp / Yakit 等） | `http://host:port/`（**端点本身**） |

### Burp Suite

Burp 官方扩展（`PortSwigger/mcp-server`）只做 SSE，且 **SSE 流在根路径**：

- `GET http://127.0.0.1:9876/` 开事件流，由 `endpoint` 事件告知 POST 端点
  （`POST /?sessionId=…`）。**填 `/sse` 是错的。**
- 端口可在 Burp 的 MCP 标签页修改；只监听 localhost。
- 无 API key，但有三重校验：Host 必须 `localhost`/`127.0.0.1` 且端口一致、Origin 必须是
  localhost、浏览器特征的 UA 无 Origin 会被拒 → 必须由 CLI/SDK 连接（本插件即是）。
- 若客户端只支持 stdio，用扩展自带的 `mcp-proxy-all.jar` 作 stdio 代理（预设里有模板）。

### Yakit

**Yakit 是否内置 MCP Server 没有官方依据**：官网手册（新/旧版）、全站 sitemap、
仓库 README 均无 MCP 条目；网传的 `127.0.0.1:11434/sse` 实为 Ollama 默认端口，
不要照抄。预设里给的是一条**待填写的占位记录**（默认停用），请在 Yakit 内确认端点后
再启用。任何旧版 HTTP+SSE 服务端都可以用这条。

## 存储

`$DSH_HOME/mcp-hub/servers.json`（原子写：临时文件 + `rename`）。

```json
{
  "version": 1,
  "servers": [
    {
      "id": "burp",
      "name": "burp",
      "enabled": true,
      "transport": "sse",
      "url": "http://127.0.0.1:9876",
      "headers": {},
      "args": [], "env": {}, "command": "", "cwd": "",
      "toolCallTimeoutMs": 60000,
      "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 }
    }
  ]
}
```

`headers` / `env` 以明文保存（与本机其它 MCP 客户端一致），不要放长期凭据。

## 设置页

- 列表：传输徽标、连接状态点、服务端版本/协议版本、工具数；展开可见工具清单与
  **调用面板**（直接填 JSON 参数执行，看原始返回）。
- 新增/编辑：按传输切换字段；**测试连接**可直接用未保存的草稿探测。
- 预设：Burp SSE、Burp stdio 代理、Yakit 占位。
- 导入：粘贴 Claude/Cursor 的 `{"mcpServers":{…}}`、数组或单条记录；`type` 字段
  兼容 `stdio` / `http` / `sse`（`http` = Streamable HTTP），只有 `url` 时按
  Streamable HTTP 处理。
- 导出：同一种 `mcpServers` 格式，可直接粘到别的客户端。
- 每 2.5 秒轮询一次状态，并在服务器上报 `tools/list_changed` 时自动重同步。

## Agent 工具

同一个注册表也暴露给模型，只有一个工具（控制上下文成本）：

| action | 说明 |
|---|---|
| `list` | 服务器 + 实时状态 + 设置页是否存在（`Settings page last seen`） |
| `tools` | 某个服务端的工具清单（含公开名与原始名） |
| `test` | 探测已有服务器或未保存的草稿，不落盘 |
| `call` | 在已连接的服务端上调用一个工具 |
| `add` / `import` | 新增一条 / 从 JSON 文档批量导入 |
| `remove` / `enable` / `disable` | 删除 / 启停（停用会同时注销工具） |

## 开发与测试

```powershell
npm test          # 集成测试：334 项（配置存储 + 全部 12 个 Remote 方法 + mcp_hub 工具 + 三种传输协议端到端）
npm run check     # 契约检查：方法名/SRC 签名/wire 一致性 + 客户端每个 payload 键都被 Host 读取
npm run verify    # 两者一起跑
```

也可以直接 `node tools\test-mcp-hub.mjs`；所有测试都从**自身文件位置**定位资源，
在任何工作目录下跑结果一致。

- **集成测试**把 `$DSH_HOME` 指到临时目录，用改写 specifier 的方式加载真实的
  `index.js`，因此不需要装 DSH、不碰你真实的 `servers.json`，也不访问外网：它自带
  两个进程内 MCP 服务端（Streamable HTTP 与旧版 HTTP+SSE），都绑在 `127.0.0.1` 的
  临时端口上。`@modelcontextprotocol/client` 也被替换成一个会说真实 JSON-RPC 的替身，
  所以传输那部分是「插件接线 + 真协议」的端到端，但不是官方 SDK 本体。
- **stdio 端到端**（连接 / `tools/list` / `tools/call` / 子进程回收，6 项）需要允许
  管道 `spawn` 的环境；被拒绝时这 6 项打印一条 `skip` 并继续，退出码仍是 0。不需要
  子进程的 stdio 覆盖（命令装配、参数拆分、`cwd`、环境清洗、传输选项）始终会跑。
- **契约检查**需要一个装有 DSH 的环境来读取宿主里的 gateway 源码：
  自动探测常见安装位置，也可以用 `DSH_APP_DIR`（或 `DSH_GATEWAY` 直接指定
  `…/@deepseek-ai/dsh-api-gateway/lib/client.js`）指过去；找不到时打印 `skip`
  并以 0 退出。`check-reserved-names.mjs` 校验的两条规则来自真实踩坑：
  方法名不能与 `RemoteNamespaceService` 表面重名（所以删除叫 `removeServer`），
  形参必须是**唯一普通标识符**（不能解构/默认值/rest，否则网关报
  `gateway/signature-invalid`），且**形参名就是客户端要发的 wire 名**。
- **传输夹具**：`tools/test-stdio-server.mjs`（stdio）、`tools/test-http-server.mjs`
  （Streamable HTTP，默认 9912）、`tools/test-sse-server.mjs`（旧版 HTTP+SSE，默认 9911）
  是三个零依赖的本地 MCP 服务端，用来在没有 Burp/Yakit 的情况下手工验证三种传输。
  两个带端口的夹具支持 `0`（临时端口，会打印实际地址），在受限环境或并行跑时更省事：
  `node tools/test-sse-server.mjs 0` 之后用打印出的地址跑
  `node tools/verify-sse-transport.mjs http://127.0.0.1:<port>/sse`（最小 SSE 冒烟，
  用的是 DSH 自带的那份 SDK）；`tools/probe-network.mjs` 用来排查本机到目标端口的连通性。
- CI（`.github/workflows/verify.yml`）在每次 push / PR 上跑 `npm test` + `npm run check`；
  套件零依赖、只连 `127.0.0.1`，CI 上没有 DSH 时契约检查会干净跳过。

### 在真实 DSH 里调试

- 安装、升级、启停都走 `plugin_manager`（`install_bundle` / `set_bundle`），不要手改 profile 的 `package.json`。
- 改了 `index.js`（Host 半边）**必须重启 DSH** 才生效；只改 `client.js` 时，客户端包在重启/安装时重新打包，之后刷新页面即可。
- 宿主日志：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`（`.error.log` 是另一份），连接类问题先看这里。
- 界面结构可以用内置的 Cordis Inspect 查（这两条是**客户端** provider）：`Slots.listSubTree` 看插槽树与占用者，`Theme.listTokens` 看可用的主题 token（本插件只用 `--dsw-alias-*` 上色，不用其他插件的组件包）。

## 目录结构

```
dsh-mcp-hub/
├─ index.js            Host 半边：传输工厂、连接池、servers.json、Remote 服务、mcp_hub 工具
├─ client.js           浏览器半边：设置页（列表/调用面板/新增编辑/预设/导入导出）
├─ cordis.patch.yml    安装时挂进 profile 的 Loader 补丁
├─ locale/{zh,en}.json 页面文案（有词典一致性测试）
├─ icon.svg            设置页图标
└─ tools/              测试与本地夹具（见上）
```

## 许可

[MIT](LICENSE) © 2026 qingchuana

## 已知边界

- 只实现 3 种传输；`sse` 依赖 SDK 的 `SSEClientTransport`，该导出已被上游标记为
  弃用（为兼容 2024-11-05 服务端保留）。
- 连接失败会按指数退避重试（最多 10 次），失败原因显示在列表与 `list` 里。
- 单次**连接有 20 秒超时**（`CONNECT_TIMEOUT_MS`）：服务端接了 socket 却一直不回
  `initialize`，会在这之后进入 `error` 并退避重试，而不是永远停在 `connecting`。
- 设置页里的 `headers`/`env` 是 **JSON 文本**，保存时先解析成对象（格式写错会当场报错，
  不会静默变成空表）；`servers.json` 里手写成文本形式也能读。
- **`servers.json` 解析失败不等于空配置**：`state().registryError` 给出文件与原因，
  第一次写入前先把读不出来的那份另存为 `servers.json.corrupt-<时间>`，`mcp_hub list`
  也会带一条 WARNING，避免一次误编辑悄悄清空全部服务器。
- 落盘写入已串行化，临时文件名带进程内序号，两个并发的 Remote 变更不会互相踩。
- 远程方法名不能与 gateway 的 `RemoteNamespaceService` 表面重名（`remove`、`has`、
  `install`…），所以删除方法叫 `removeServer`；`tools/check-reserved-names.mjs`
  会对当前方法表做这项检查。
- **已知不完美**（都不是数据损坏，改起来需要定行为，先记在这里）：
  - `exportJson` 只输出可移植的 `mcpServers` 字段（`transport`/`command`/`url`/`args`/
    `env`/`headers`/`cwd`，这是为了能直接粘给别的客户端），所以「导出再导入」会丢掉
    `enabled`、`description`、`toolCallTimeoutMs`、`reconnect`；而且字段按传输写：
    stdio 记录不带 `headers`、http/sse 记录不带 `env`，往返时这两项会消失；
  - `importJson` 命中同名/同 id 记录时保留原有的 `enabled` 与 `source`，但描述、超时与
    重连参数以导入内容为准；没有端点（stdio 无 `command`、其余无 `url`）的记录会被
    跳过并在返回里列进 `skipped`，非记录条目记为 `entry-<序号>` —— 目前只有 Agent 工具的
    `import` 会把它打出来，设置页的导入结果还没显示这一项；
  - 子进程环境清洗是子串匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`，`TOKENIZERS_PARALLELISM`
    这类无关变量也会被丢掉（显式填写的 `env` 优先生效）。
