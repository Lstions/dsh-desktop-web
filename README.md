# 桌面版 Web 访问插件（含密码登录）

> npm: [dsh-desktop-web](https://www.npmjs.com/package/dsh-desktop-web)（首个发布版本 `2.4.0`）

在**桌面版运行中**，用浏览器从多个网段访问同一个 Host。会话、插件、工作区、后台任务全部共享——因为只有一个进程，桌面窗口和浏览器只是它的两个客户端。对外只暴露密码登录，不发送任何 DSH 凭据。

## 安装

### 从 npm（推荐）

```sh
# 桌面版 Host 的 profile 里安装（本包声明 dsh.bundle.patch，安装后自动进入 dsh.profile.bundles）
dsh plugin --profile web add dsh-desktop-web@2.4.0
# 然后重启桌面版
dsh --profile web
```

### 从本地源码（开发）

1. 把本目录放到任意位置（不需要构建，源码即产物）。
2. 用 DSH 的插件管理安装这个目录（`install_bundle` 指向该目录），或在 profile 的 `package.json` 里 `link:` 它并加入 `dsh.profile.bundles`。
3. 重启桌面版，让 Client 半进入模块清单。

### 首次使用

打开 **`http://127.0.0.1:8091/`** → 创建账户 → 之后各网段都用同一套账号密码登录。

首次启动会监听 loopback。要对外提供服务，去 **设置 → 安全 → 桥接** 勾选网卡（见下文「按网卡绑定」）。

配置示例（`cordis.patch.yml` 里的插件行）：

```yaml
- id: desktop-web
  name: 'dsh-desktop-web'
  config:
    bind: ['Wi-Fi', 'Tailscale']   # 网卡名，IP 变了也不失效
    port: 8091
    accessKey: ''                  # 留空则每次启动随机生成
    sessionDays: 30
    bootstrapLoopbackOnly: true    # 只允许本机创建第一个账户
```

带 `?key=` 的引导 URL 列表写在 `~/.dsh/desktop-web.url`，只作为建账户之前的入口。

## 功能（对齐 dsh-web-password-auth）

| 能力 | 说明 |
|---|---|
| **应用内设置页** | 设置 → 安全：改用户名、改密码、开关两步验证、退出登录 |
| **桥接配置** | 同一面板里改监听地址、端口、会话天数、限流、TOTP 开关、访问密钥 |
| **插件详情页** | 插件 → 本插件，同一套界面，不必去设置里翻 |
| 首次创建账户 | 用户名 + 密码，scrypt 哈希（N=32768, r=8, p=1，约 66 ms / 32 MB） |
| 密码登录 | 之后每次访问用密码进入 |
| 持久会话 | 签名 cookie，默认 30 天，跨浏览器重启有效 |
| 退出登录 | **服务端撤销**，不只是清 cookie |
| 改密码 | 立即让所有已发 cookie 失效，需重新登录 |
| 改用户名 | 只改显示名，会话保持 |
| 两步验证 | TOTP（RFC 6238），扫码注册，防重放 |
| 登录限流 | 连续失败达上限后按来源地址锁定 |
| 中英双语 | 界面按 locale，登录页按浏览器 Accept-Language |

## 桥接配置（UI 可改）

监听地址、端口和各策略项都是**插件行（Loader row）的配置**，面板改的就是它本身，没有第二份设置文件：

- 读取：`ctx.configEditor.entries()` 找到本插件的行，显示它当前的配置。
- 写入：`ctx.configEditor.edit()` —— 和手改 profile patch 走完全相同的校验与写入路径。
- 因此写入的位置是 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里一条 `- id: desktop-web` 覆盖行。

**保存后立即生效，不用重启桌面版。** `configEditor.edit()` 会走 Loader 协调，本插件行被 dispose 再重新 `apply`，监听器按新配置重新绑定。

这一点是实测确认的，不是推断：把监听改成 `127.0.0.1:8091` + `127.0.0.1:8092` 后，8092 立刻在监听，原来 LAN / Tailnet 两个监听同时消失；改回三个地址后又同时恢复。

（原先我按"必须重启"实现了 `restartRequired` 提示，实测后删掉了——那句话是错的。）

面板还会显示**「正在监听」**（本进程真实绑定的地址）。正常情况下它和新配置一致；不一致说明有地址绑定失败，这正是用户最需要看到实情的时候。

校验是双层的：面板提交前由 `config.js` 校验（地址格式、端口范围、通配符拒绝、数值边界），保存后再经 `configEditor` 与 `parseListens` 在激活时校验。

**故意不支持 `0.0.0.0`**：宿主的 Web carrier 本来就拒绝通配绑定，面板允许它就等于让人配置一个必然失败的东西。要覆盖所有网卡，就逐张勾选。

## 按网卡绑定，而不是填死 IP

写死 `192.168.1.10:8091` 的配置会在这些情况下**静默失效**：DHCP 续租换了地址、换了 Wi-Fi、笔记本从公司带回家里、Tailscale 重新分配地址。桥接本身没崩，只是那个网段再也连不上，而且很难看出是配置过期。

所以配置的首选形态是**网卡名**：

```yaml
bind:                            # 优先；IP 变了也不失效
  - 'Wi-Fi'
  - 'Tailscale'
  - 'Loopback Pseudo-Interface 1'
port: 8091
listen: []                       # 旧的手动地址，保留兼容
```

- 启动时（以及每次保存配置后）才把网卡名解析成**当前**地址，配置文件里不含任何 IP。
- `bind` 非空时 `listen` **完全被忽略**，避免迁移到一半时同一地址绑两次。
- 面板上点「刷新网卡」会重新枚举——插拔网线、连上 Wi-Fi 后不用重启。
- 面板还提供「从手动地址生成网卡选择」：把现有 IP 反查成网卡，一条命令完成迁移，且不会静默丢地址（查不到对应网卡的地址会报错而不是被丢掉）。

**网卡不可用时的行为**：某张网卡暂时不存在（没插网线 / Wi-Fi 关着），只跳过它并记日志，其余照常绑定；**一张都解析不出来**时退回 loopback 而不是让插件激活失败——否则面板本身也打不开，用户没法修。这条是有意为之：宁可少绑，也不要整个插件挂掉。

**只枚举 IPv4**：宿主的 carrier 每个监听器只讲一个地址族，同时列 IPv4/IPv6 会让一张网卡出现两次，用户无法判断浏览器实际会连哪个。

实机验证：把配置从三个固定地址迁移成三张网卡名后，`listen` 被清空、`bind` 只留名字，监听结果**完全不变**（loopback / LAN / tailnet 三个地址，端口都是 8091）。

## UI 结构

界面是**应用内的动态 Client 插件**（`client.js`），不是独立页面——和 upstream 一致：

- 由宿主的模块加载器以 `window.__ModuleLoader__.load({ id, factory })` 执行，React 从共享模块表取，不需要打包，也不安装第二份 React。
- 注册到 `settings.section`（order 25，排在 Agent presets 之后、Market 之前）和 `plugins.detail.section`。
- 样式用 `--dsw-alias-*` 主题 token，跟随深浅色主题。
- 文案走 `ctx.locale.register`，`t` 是函数而非对象——属性访问会得到 undefined 并让面板空白，所以统一经 `translator()` 并回退成键名。
- 数据来自本插件自己的 JSON API：`/desktop-web/status|setup|username|password|totp/*|logout`。

### 样式注入与主题变量：两个让 UI「变丑」的真 bug

第一版面板在截图里完全没样式——输入框撑满、`✕` 掉到下一行、地址挤成一坨、没有圆角和层次。看着像审美问题，实际是两个可验证的缺陷：

**1. `<style>` 必须保持未打标记，否则宿主不接管。**

宿主 client 加载器只接管**没有 `data-plugin` 属性**的样式：

```js
// lib/client.js（精简）
const untaggedStyles = () => new Set(document.querySelectorAll('style:not([data-plugin])'));
for (const el of untaggedStyles()) if (!before.has(el)) el.setAttribute('data-plugin', id);
```

第一版写了 `tag.dataset.plugin = 'dsh-desktop-web'`（而且 id 还是错的短名），这条样式既不在「未标记」集合里，也不属于任何 owner id，于是留在 `document.head` 里对面板毫无作用。正确写法：

```js
const tag = document.createElement('style');
tag.dataset.pluginCss = CSS_TAG;   // 仅作去重标记
// 不要设置 data-plugin
tag.textContent = CSS;
document.head.appendChild(tag);
```

**2. 主题变量只能用宿主真实提供的 14 个。**

第一版用了 `--dsw-alias-border-l4`、`--dsw-alias-bg-layer-3`、`--dsw-alias-label-tertiary` 这些**不存在**的名字。不存在的 CSS 变量不会报错，只会让边框、背景、弱化文字全部消失——于是看起来像「没设计」。可用的只有：

```
--dsw-alias-bg-base           --dsw-alias-bg-layer-1      --dsw-alias-bg-layer-2
--dsw-alias-bg-overlay        --dsw-alias-border-l1       --dsw-alias-border-l2
--dsw-alias-brand-primary     --dsw-alias-label-primary    --dsw-alias-label-secondary
--dsw-alias-state-error-primary  --dsw-alias-state-idle-primary
--dsw-alias-state-success-primary --dsw-alias-state-warn-primary
--dsw-specific-sidebar-fill
```

查证方式：`cordis_inspect_query` 的 Client `Theme.listTokens`。

### 布局取舍

- **每块内容一张卡片**（`dw_card` + 头 + 体 + 可选底栏），而不是一条长列表；面板整体居中限宽 640px。
- **地址行用 grid `minmax(0,1fr) auto`**，不是「flex + 输入框 `width:100%` + 兄弟按钮」——后者会把删除按钮挤到下一行，正是第一版的样子。
- **正在监听做成只读读数面板**（`dw_readout` + 带状态点的 `dw_chip`），和可编辑的地址列表在视觉上明确区分。
- **数字策略项 2 列**，窄屏（≤420px）自动降为 1 列。
- **保存按钮在卡片底栏右侧**，与表单内容分开，不再是漂在页面角落的黑色按钮。
- 交互与无障碍都保留：地址输入框有 `aria-label`，开关是真正的 `<input type="checkbox">`，忙碌/只读时全部 `disabled`。


### 两处都挂同一套 API

面板是 Client 插件，**它渲染在 Web UI 出现的任何地方**——包括桌面窗口。所以 API 挂在两个地方：

| 位置 | 谁在用 | 认证 |
|---|---|---|
| 桥接监听器（8091 等） | 手机/另一台电脑的浏览器 | 密码会话 cookie |
| Host 自己的 webServer | **桌面窗口里的面板** | `ctx.connection.requestRejection` + `admit`，要求宿主 owner 凭据 |

桌面窗口的 `dsh-app://app/*` 请求，除构建产物（`/`、`/index.html`、`/assets/*`）外全部经 `forwardWebRequest` 转给 Host。第一版只在桥接上挂了 API，于是桌面窗口里面板能渲染却读不到数据，显示「读取状态失败」。

### 插件 Web 路由默认不在宿主栅栏后面

**这是实测发现的一个洞。** 把路由挂到 `ctx.webServer.register` 之后，`GET /` 返回 401，但 `GET /desktop-web/config` 返回 **200 且无任何凭据**——本机任意进程都能改桥接密码、读配置、开关两步验证。

插件注册的 Web 路由**不会**自动套用宿主的连接认证，必须自己调：

```js
connection.requestRejection(request)   // Host/Origin 栅栏
connection.admit(request)              // 签名凭据 → peer
```

修好后实测：无凭据 401，带宿主 owner cookie 200。

`/status` 是唯一免会话的端点（面板要知道该显示「建账户」还是编辑器），但它**只告诉未认证调用者「有没有账户」，不泄露用户名**。

### 面板不能假设存在 `/login`

桥接上未登录会被送到 `/login`；桌面窗口没有这个页面（由 app 协议直接出 dist），跳过去就是 404。所以所有跳转都收敛到 `goToSignIn()`，先判断协议：`http(s)` 才跳，否则就地提示。

**纯视图可测**：`SecurityView` 只读 props、只调回调，`SecuritySection` 独占状态与请求。这样漏掉的文案键或抛异常的分支能在发布前被渲染测试抓住，而不是变成一块空白面板。


## 与上游插件的三个关键差异

这套逻辑是从 [`dsh-web-password-auth`](https://github.com/Lstions/dsh-web-password-auth)（MIT，v0.7.1）移植的，但**照搬会在桌面版上出三个洞**，所以做了针对性改造：

**1. 所有路径都守，不只 `/`。**
上游只拦截 `/` 和 `/index.html`，依赖宿主自己的 cookie 守 `/api/*`。但本插件会**向上游注入宿主 owner cookie**——若 `/api/remote.mux` 不守，任何人无需密码即可拿到 owner 权限。所以 gate 在每次转发前运行，**WebSocket 升级同样校验**。

**2. 建账户的"本机"判定看监听地址，不看 socket。**
上游用 `req.socket.remoteAddress === '127.0.0.1'` 判断本机。经过本插件转发后所有请求的来源都是 `127.0.0.1`，这道防线会**静默失效**——任何能连上 8091 的人都能抢先创建账户成为 owner。本插件改为判断**该监听器绑定的地址**是否 loopback，代理无法伪装。

**3. 访问密钥只是引导，不是后门。**
`?key=` 仅在还没有账户时可用；一旦有账号，它签不进任何东西。这样"改密码"才真的能把门锁上。

## 安全语义（实测）

| 检查 | 结果 |
|---|---|
| loopback 无账号 | 显示创建账户页 |
| **LAN / tailnet 无账号** | 显示"仅限本机创建"提示，`POST /setup` → `403` |
| 未认证访问 `/` | 登录页（不泄露应用） |
| 未认证 `/api/remote.mux` | `401` |
| 已认证 `/` | `200`，42114 字节完整 UI（含 `__DSH_BOOT__`） |
| 已认证 `/api/remote.mux` | `101 Switching Protocols` |
| 错误密码 | `401`，第 5 次后 `429` 锁定 |
| 登出后重放旧 cookie | 登录页（服务端已撤销） |
| 改密码后旧会话 | 全部失效 |
| cookie 跨 authority | 拒绝（载荷绑定 host:port） |

## 配置

`cordis.patch.yml`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `listen` | 见上 | 一个地址或地址列表，逐个监听，绑不上只告警 |
| `accessKey` | 空 = 每次随机 | 固定引导密钥 |
| `sessionDays` | `30` | 会话有效期 |
| `bootstrapLoopbackOnly` | `true` | 仅 loopback 监听器可建首个账户 |
| `maxAttempts` | `5` | 失败几次后锁定 |
| `lockoutMs` | `300000` | 锁定时长 |
| `minPasswordLength` | `8` | 最短密码 |
| `totpIssuer` | `DSH` | 验证器 App 显示的名称 |
| `totpAvailable` | `true` | 是否提供两步验证 |

改完在插件里关掉再打开。

## 凭据存放

全部在 `$DSH_HOME/.credentials.yaml`，不新增存储：

- `desktop-web/password` — 用户名 + scrypt 哈希
- `desktop-web/totp` — base32 密钥、启用标记、已用时间步
- `desktop-web/session-key` — 会话签名密钥
- `desktop-web/generation` — 撤销代数（提升即让所有旧 cookie 失效）

**明文密码从不落盘。** 宿主的 `client-connection/browser-session` 只读不写——撤销本插件的会话不会影响桌面窗口自己。

重新开始：删掉 `desktop-web/password` 记录后重载插件，下次访问会重新要求创建账户。

## 实现要点

- **`client.js`** — 应用内设置页（动态 Client 插件，注册到 `settings.section` 与 `plugins.detail.section`）。
- **`auth.js`** — cookie 签发/验签（与宿主 `v1` 格式逐字节兼容）、scrypt、TOTP。已用 RFC 6238 官方向量验证。
- **`qr.js`** — 自带 QR 编码器（model 2, byte 模式, ECC M, 版本 1–10），不引入 `qrcode` 依赖。已用独立解码器做往返验证，并用校验子验证 Reed-Solomon 正确。
- **`pages.js`** — 服务端渲染登录/建号页（未认证时 SPA 还没启动，只能在 Host 侧产出），深色默认、跟随系统，中英双语。
- **`gate.js`** — 认证流程、限流、TOTP、会话撤销、`/desktop-web/*` JSON API。
- **`config.js`** — 桥接配置的校验与投影（网卡名、端口、地址格式、通配符拒绝）。
- **`interfaces.js`** — 网卡枚举与「网卡名 → 当前地址」解析。
- **`index.js`** — 多地址监听、注入上游 cookie、改写 Host/Origin、双向转发、Host 侧配置路由。

## 坑：client 半不加载

**`exports` 必须含 `"./package.json": "./package.json"`。**

宿主的 client 模块系统用 `createRequire(baseUrl).resolve('<pkg>/package.json')` 定位 manifest 来读取 `dsh.client`。没有这条导出，解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，该包被**静默跳过**——不报错、不告警，`settings.section` 里就是不出现，boot payload 里也没有。

而且 `pkgMeta` 会把这个失败**永久负缓存**，运行时无法清除；**改完必须重启桌面版**才重新扫描。

## 坑：bundle id 必须等于包名（否则启动崩溃）

`client.js` 里 `window.__ModuleLoader__.load({ id, factory })` 的 `id` **必须与 `package.json` 的 `name` 完全一致**（当前都是 `dsh-desktop-web`）。

加载器按 bundle 声明的 `id` 建 factory 表，而宿主的 roster 按**包名**索引同一个 bundle。两者不一致会让同一个 bundle 注册两次，桌面版启动直接失败：

```
web boot: 1 entry did not activate
dsh-desktop-web: import failed
client-modules: duplicate factory registration for "dsh-desktop-web" (bundle executed twice without invalidate?)
```

历史：本插件早期包名是 `@local/dsh-desktop-web`，`client.js` 里却写成短名 `dsh-desktop-web`，于是崩了。现在包名统一为 `dsh-desktop-web`。改包名时务必同步：`client.js` 的 bundle `id`、`client.js` 的 `OUR_PACKAGE`、`gate.js` 的 `PLUGIN_PACKAGE`、`cordis.patch.yml` 的行 `name`。

**注意**：崩溃恢复会把 profile 的 `bundles` 列表砍到只剩基础几项（本机从 13 项变成 3 项），`node_modules` 里的包仍在，需要手工把列表补回去。

## 已知边界

- **明文 HTTP**：密码在网络上可读。跨网段请走 Tailscale（加密）或前面加 TLS 反代。cookie 因此没有 `Secure` 标志。
- **会话密钥在凭据记录中**：桌面版重启后会话仍有效（密钥持久化），这是有意的。
- **限流按来源 IP**：经代理时所有人共享一个来源，必要时可调大 `maxAttempts` 或前置更精确的限流。
- **只有一套账户**：所有登录者共享宿主 owner 身份，用户名是标签而非多用户体系。
- **改 client.js 需重启桌面版**：浏览器插件清单在启动时组装。

## 文件

| 文件 | 作用 |
|---|---|
| [`index.js`](index.js) | 插件本体：多监听、注入 cookie、转发、Host 侧配置路由 |
| [`client.js`](client.js) | 应用内设置页（账户安全 + 桥接配置 + 插件详情页） |
| [`gate.js`](gate.js) | 密码门：登录、限流、TOTP、会话撤销、JSON API |
| [`config.js`](config.js) | 桥接配置校验与投影 |
| [`interfaces.js`](interfaces.js) | 网卡枚举与网卡名→地址解析 |
| [`auth.js`](auth.js) | 加密基元：cookie、scrypt、TOTP |
| [`pages.js`](pages.js) | 服务端渲染登录/建号页 |
| [`qr.js`](qr.js) | 二维码编码器 |
| [`cordis.patch.yml`](cordis.patch.yml) | 插件行与默认配置 |
| [`locale/en.json`](locale/en.json) / [`locale/zh.json`](locale/zh.json) | 插件管理页元数据 |
| [`icon.svg`](icon.svg) | 插件图标 |

## 许可证

[MIT](LICENSE)。

密码登录、会话 cookie、scrypt 与 TOTP 的移植来源是 [`dsh-web-password-auth`](https://github.com/Lstions/dsh-web-password-auth)（MIT），署名与范围见 [NOTICE](NOTICE)。本项目的差异与改造原因见上文「与上游插件的三个关键差异」和「按网卡绑定」。

