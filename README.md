# XDOJ for VS Code

把 XDOJ 搬进编辑器：侧栏列题目、题面在标签页里渲染、写完的源文件一键提交、评测结果自动刷新。
不必再来回切浏览器。

> ## 声明
>
> 本扩展**只是把 XDOJ 的网页界面搬进 VS Code**：列题目、渲染题面、提交源文件、显示评测结果，
> 调用的都是 XDOJ 官方接口，和在浏览器里点一遍没有区别。
>
> 它**不涉及任何作弊行为**——没有 AI 自动做题、没有答案检索、没有自动刷题，
> 也不绕过评测、查重或任何限制。代码始终要你自己写。

## 功能

- **比赛 / 题目侧栏**。XDOJ 的题目挂在比赛（场次）下，所以是两级树：比赛 → 题目，
  展开比赛时才懒加载。比赛按「进行中 → 已结束 → 未开始」排序，已通过的题打勾，
  支持按标题 / 题号 / 标签过滤。
- **题面标签页**。同一道题只开一个标签；所有题面共用一个编辑器组，开多少道都只加标签。
  按内容自动选择渲染方式：
  - **PDF** —— 内置 [pdf.js](https://mozilla.github.io/pdf.js/) 渲染，支持连续滚动、翻页、缩放、适应宽度，
    cmaps / 标准字体 / wasm 解码器随扩展打包，离线可用。
  - **DOCX / DOC / 压缩包等** —— 下载到本地（默认 `<工作区>/problems/`），标签页里给
    「用系统程序打开」「在文件夹中显示」。
  - **TXT / HTML** —— 直接内联显示，HTML 中的脚本已被禁用。
- **一键提交**。编辑器标题栏、右键菜单或题面标签页都能触发；提交前自动保存。
  源码按**文件原始字节**上传，GB2312 / GB18030 编码的源文件不会被改动。
- **提交记录**。侧栏实时显示 排队 → 评测中 → 结果，出结果时弹通知；
  点开某条提交可看详情、编译输出，以及**逐测试点结果**（通过情况、耗时）。
- **账户登录**。配置地址、账户、密码三项即可；会话加密保存在 VS Code 凭据库，
  重启不用重新登录，登录态失效时会自动重登并重试。
- **状态栏**。显示当前题目与最近一次评测结果。

## 快速开始

### 1. 安装

在 VS Code 的扩展视图（`Ctrl+Shift+X`）里搜索 **XDOJ**，或直接按扩展 ID 安装：

```bash
code --install-extension Terabinaryte.xdoj-vscode
```

也可以从 [GitHub Releases](https://github.com/Terabinaryte/xdoj-vscode/releases)
下载 `.vsix` 后安装：

```bash
code --install-extension xdoj-vscode-<版本>.vsix
```

### 2. 配置

打开设置（`Ctrl+,`）搜索 `xdoj`，填两项：

| 配置 | 说明 |
| --- | --- |
| `xdoj.endpoint` | **必填**，OJ 站点根地址，例如 `http://your-oj.example/` |
| `xdoj.account` | 账户（学号 / 用户名） |

密码不要写进设置。运行命令 **`XDOJ: 设置密码`**，它会存进 VS Code 的加密凭据库
（SecretStorage），不会出现在 `settings.json` 里。

地址没填时扩展会提示；也可以先把 `xdoj.useMockData` 设为 `true`，用内置样例数据把界面点一遍（不联网）。

### 3. 登录

命令面板（`Ctrl+Shift+P`）运行 **`XDOJ: 登录`**，或直接点侧栏的 XDOJ 图标。

## 使用

**看题**：侧栏「比赛 / 题目」里展开比赛，点题目即在标签页打开题面。

**写题**：在 VS Code 里正常写 `.cpp` 文件。文件里加一行 `// @xdoj <题号>` 可以把它和题目绑定，
之后提交会自动认题；不写也行，会按「当前题面标签页 → 最近打开过的题」推断，实在不行会弹选择框。

**提交**：`Ctrl+Shift+P` 运行 `XDOJ: 提交当前文件`，或用编辑器标题栏的按钮。
提交后侧栏「提交记录」会显示状态，出结果时弹通知。

**看结果**：点侧栏里的某条记录，详情页会列出逐测试点结果。

## 配置速查

常见几项，其余在设置里搜索 `xdoj` 都能看到：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `xdoj.endpoint` | 空 | OJ 站点根地址（必填） |
| `xdoj.account` | 空 | 账户 |
| `xdoj.useMockData` | `false` | 使用内置样例数据，不联网 |
| `xdoj.downloadDir` | `problems` | 题面落盘目录，留空则不落盘 |
| `xdoj.problemOpenColumn` | `beside` | 题面开在侧边栏还是当前栏 |
| `xdoj.submitLanguage` | `2` | 提交语言标识（`GNU C/C++`） |
| `xdoj.pollIntervalMs` | `2000` | 评测状态轮询间隔 |
| `xdoj.httpTransport` | `fetch` | HTTP 实现，可切换为 `node` |

接口路径、字段口径、协议细节见 `docs/api.md`。

## 常见问题

**提示「还没配置站点根地址」**
填 `xdoj.endpoint`，注意是根地址（`http://host/`），不是具体接口。

**登录成功但侧栏是空的**
先运行 `刷新比赛 / 题目列表`。若仍然为空，运行 `诊断接口连通性`，它会逐个接口探活并给出响应摘要。

**某个接口返回 500 / 连接异常**
先试 `诊断接口连通性`；仍不行可以在设置里把 `xdoj.httpTransport` 换成 `node` 再试。

**提交后状态显示「未知」**
说明服务端返回的判定文案不在已知映射里。日志（`输出 → XDOJ`）会带上原始文案，可以据此补充映射。

**中文注释的源码提交后编译错误**
扩展按文件原始字节上传，不会转码。如果编辑器里本来就是乱码（VS Code 把 GB2312 当成了 UTF-8），
请用右下角编码菜单「通过编码重新打开」选正确编码后再提交。

**安装时出现 `DEP0169` 警告（`url.parse()` is deprecated）**
这是 **VS Code 自身**的告警，不是扩展产生的：装完扩展后 CLI 会去扩展市场查元数据
（`cliProcessMain.js` → `updateMetadata` → `queryRawGalleryExtensions`），
那条 HTTP 路径用了已废弃的 `url.parse`。本扩展的代码里没有任何 `url.parse`，可以忽略。
想让它别打印，可以：

```bash
NODE_OPTIONS=--no-deprecation code --install-extension <文件>.vsix
```

或者用扩展面板的「…」→「从 VSIX 安装…」，走窗口进程，不会在终端打印这条。

**忘了密码 / 想换账号**
`XDOJ: 退出登录`，再 `XDOJ: 设置密码` 后重新登录。

## 隐私与凭据

| 数据 | 存放位置 |
| --- | --- |
| 密码（`XDOJ: 设置密码`） | VS Code SecretStorage（系统钥匙串） |
| 会话 Cookie / 令牌 | SecretStorage + 内存，日志中一律脱敏为 `***` |
| 下载的题面 | `<工作区>/problems/`（可用 `xdoj.downloadDir` 关闭落盘） |
| 源码 | 仅提交时读取一次 |

所有请求只发往 `xdoj.endpoint` 配置的主机，没有任何遥测或第三方上报。
请求体不会写入日志（密码就在登录请求体里）。

> 若你确实在 `settings.json` 里填了 `xdoj.password`，那是明文保存的，
> 扩展激活时会在日志里提醒你改用命令设置。

## 已知限制

- **DOCX 不在编辑器内渲染**。题面接口需要登录态，Office 在线预览抓不到文件，
  因此走本地下载后用系统程序打开。
- 只支持「提交并等待结果」，不支持对拍、自定义测试等本地评测。
- 评测状态是固定间隔轮询，不是推送。

## 开发

```bash
npm install       # 安装依赖，并把 pdf.js 资源复制到 media/vendor/pdfjs/
npm run build     # 编译到 out/
npm run watch     # 增量编译
npm run typecheck # 仅类型检查
npm run smoke     # 冒烟测试（用 vscode API 桩跑真实编译产物）
npm run verify    # typecheck + build + smoke
npm run package   # 打包 .vsix
npm run publish   # 发布到 VS Code 扩展市场（需先 npx vsce login Terabinaryte）
```

在 VS Code 里打开本目录按 `F5` 即启动扩展开发宿主。

```
src/
  extension.ts        入口：注册命令、视图、状态栏
  service.ts          核心编排：缓存、提交、轮询、诊断
  auth.ts             登录会话与凭据存储
  api/                接口客户端、传输层、响应归一化
  views/              侧栏树
  util/               工具函数
media/                题面 Webview 的静态资源（pdf.js 由构建复制）
docs/api.md           接口契约与实测记录
scripts/              冒烟测试与资源复制
tools/                抓包与调试脚本
```

## 许可

MIT（见 `LICENSE`）。第三方组件（主要是 PDF.js，Apache-2.0）见 `THIRD-PARTY-NOTICES.md`。

本项目是非官方的第三方客户端，与 XDOJ 官方无关。

## 致谢

- **Made With DeepSeek Harness**
- 题面渲染使用 [PDF.js](https://mozilla.github.io/pdf.js/)（Apache-2.0）
