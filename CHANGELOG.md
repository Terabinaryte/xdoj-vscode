# 更新日志

本项目的重要变更记录。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
`0.0.x` 阶段配置项与内部结构仍可能变动。

## 0.0.27

### 变更

- 作者与发布者改为 **Terabinaryte**（`package.json` 的 `publisher` / `author`、
  `LICENSE` 版权行）。
  ⚠️ 发布者变了，扩展 ID 也随之从 `kazuha.xdoj-vscode` 变成 `Terabinaryte.xdoj-vscode`，
  旧版本会作为另一个扩展并存，装新包前建议先卸掉旧的。
- 重写 README：改为以使用者为中心的结构（安装 → 配置 → 使用 → 常见问题 → 隐私 → 开发），
  并在开头加入**免责声明** —— 本扩展只是把 XDOJ 的界面搬进编辑器，
  不提供也不打算提供作弊能力（无 AI 做题、无答案检索、不绕过评测）。
- 新增「致谢」：Made With DeepSeek Harness。

### 文档

- README 中深层接口细节指向 `docs/api.md`，不再重复展开。

## 0.0.26

### 变更

- **清除代码与文档中的全部数字 ID。** 抓包 fixture、示例数据、注释与文档里的
  比赛 / 题目 / 提交 / 判题 / 测试点 / 班级 / 学号，全部换成符号化标识：
  内置样例数据用 `sample-*`，测试 fixture 用 `fixture-*`，文档用 `<比赛ID>` 这类占位符。
  只保留协议本身的常量（例如 `languageId=2` 表示 GNU C/C++）。
- 真实课程信息（比赛标题、上课时段、教师备注）一并替换为示例值。

### 修复

- 「没有配置端点」时的错误提示原先会显示为「不支持的协议」，现明确指向 `xdoj.endpoint`。

### 文档

- 重写本文件。此前每个版本都是一篇排查日记，混着当时被推翻的结论，
  读起来像工作记录而不是变更记录。

### 内部

- 样例数据（`sample-*`）与测试 fixture（`fixture-*`）分属不同命名空间，
  避免题号同名导致的标签页复用；同时移除了为此加的测试补丁。
- 从 judge 页面刮 `judgeId` 时排除 `null` / `undefined` 这类占位值。

## 0.0.25

### 变更

- 清除仓库中最后一处硬编码的 OJ 地址：文档改用 `your-oj.example`，
  `tools/curl_steps.sh` 抽成 `OJ` 变量，`tools/dump_server.py` 的 `--upstream` 不再有默认值。

### 修复

- `tools/curl_steps.sh` 的 `SID=<占位>` 缺引号，`bash -n` 直接语法错误。
- proxy 模式未指定上游时现在会报错退出，不再静默转发到写死的地址。

## 0.0.24

### 变更

- `xdoj.endpoint` 默认值改为**空**（此前默认指向某台具体服务器的 IP）。
  首次激活时若为空，提示配置并给出「打开设置」「先用样例数据看看」两个选项；
  状态栏显示「未配置地址」，不再显示误导性的「未登录」。

### 修复

- **PDF 放大后左侧被裁切且无法滚动到。** 根本原因是 `.pdf-container` 用
  `align-items: center` 居中页面，内容比可视区宽时溢出被平分到两侧，而 `scrollLeft`
  不能为负，导致左侧不可达。改为贴左对齐 + `.pdf-page` 的 `margin: 0 auto` 居中。
- 地址为空时的报错从「不支持的协议」改为明确提示「还没配置站点根地址」。

## 0.0.23

### 安全

- **修复扩展包内泄露凭据的问题。** 调试用抓包日志 `dump_requests.log`（含明文账号密码
  与真实会话 Cookie）未被 `.vscodeignore` 排除，被打进了 0.0.17 起的每个 `.vsix`。
  已删除该文件，补齐忽略规则；文档与工具中的真实学号改为占位值。
- **升级 pdf.js 至 6.4.299**，修复 [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) /
  CVE-2026-16633（恶意 PDF 可执行任意 JS，影响 `>= 5.6.83 < 6.2.108`）。
  同时显式关闭 PDF 内嵌脚本：`enableScripting` / `enableXfa` / `isEvalSupported`。
- `xdoj.password`（明文存于 `settings.json`）被使用时，激活阶段记录一条警告，
  引导改用命令「XDOJ: 设置密码」（SecretStorage）。

### 变更

- `pdfjs-dist` 移至 `devDependencies` 并锁定版本；`@types/vscode` 锁定到 `1.90.0`，
  与 `engines.vscode` 对齐。
- 采用 MIT 许可，新增 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`；README 增加「隐私与凭据」一节。

## 0.0.22

### 修复

- **逐测试点结果取不到 `judgeId`。** 改为 `GET submission/listJudge.do` 换取
  （返回记录的 `id` 即 `judgeId`，与提交 ID 不同），页面抓取降为兜底。

## 0.0.21

### 新增

- 提交详情页展示逐测试点结果（`result` / 耗时 / 内存）。**按需加载**：
  仅在打开提交详情标签页时请求，同一条提交不重复请求。

### 修复

- **WA 显示为「未知」。** XDOJ 的文案是「结果错误」，不含「答案」二字，
  原有的 `答案错误` 规则无法命中。补齐 XDOJ 的整套判定文案。
- 提交列表不再显示恒为 0 的耗时 / 内存。

## 0.0.20

### 修复

- **每打开一道题就多出一个编辑器组。** `ViewColumn.Beside` 每次调用都会新开一栏，
  且创建后 `reveal` 又传了同一个值。现在复用已有栏位，
  `reveal` 一律使用面板的实际列；提交详情页也开在题面所在栏。

## 0.0.19

### 修复

- **明明开着 C/C++ 文件却提示「没有打开文件」。** `activeTextEditor` 仅在文本编辑器
  持有焦点时非空。现在按「当前编辑器 → 最近激活过的 C/C++ 编辑器 → 任一可见的 C/C++ 编辑器」查找。

### 变更

- 未保存（untitled）的文件不再提交，改为提示并给出「另存为…」选项，保存后继续提交流程。
- 保存失败时改用内存中的内容，避免提交磁盘上的旧代码。

## 0.0.18

### 修复

- **GB2312 / GB18030 源码提交后内容被改写。** 此前通过 `document.getText()` 取字符串，
  `Blob` 会再按 UTF-8 编码。现在读取文件原始字节上传，与浏览器 `<input type="file">` 一致。
- 新增 `xdoj.submitTranscode`（默认 `none`），仅在服务端明确要求 UTF-8 时改为 `utf8`。

## 0.0.17

### 修复

- **`contest/problems.do` 稳定返回 HTTP 500。** 根因是该接口从会话中读取「当前比赛」且未判空，
  而这一状态由 `POST team/selectContest.do` 写入。扩展此前直接请求该 AJAX 接口，缺了前置步骤。
  新增 `xdoj.prewarmSteps` / `xdoj.prewarmEnabled`，默认在请求前发送 `selectContest.do`，
  并按「每场比赛一次」「换会话后重做」执行。

  > 该问题在 0.0.11 与 0.0.12 曾被误判为「需要先访问页面」和「Cookie 顺序」，
  > 两次归因均已被后续实验否定。

## 0.0.16

### 新增

- `tools/dump_server.py`：转储扩展实际发出的原始请求。
  `mock` 模式离线返回构造响应；`proxy` 模式原样转发并记录头部顺序、大小写与连接复用情况。

## 0.0.15

### 新增

- `xdoj.httpTransport`：可选 `fetch`（undici）或 `node`（`node:http`，行为接近 curl）。
- 5xx 自动重试（仅 GET/HEAD），对应 `xdoj.retryOnServerError` / `xdoj.retryDelayMs`。
- Tomcat 错误页提取「消息」「根本原因」两个字段写入日志。

### 变更

- 登录请求改走统一传输层，与业务请求行为一致。

## 0.0.14

### 新增

- 诊断报告列出登录页上的全部表单控件，用于发现服务端期望但客户端未提交的字段。

## 0.0.13

### 新增

- 诊断命令增加「换会话实验」：走一遍浏览器登录流程取得新会话后重试失败接口，
  用于区分请求头问题与会话状态问题。
- `xdoj.endpoints.loginPage`。

### 变更

- 支持对失败接口逐个摘除请求头做二分定位。

## 0.0.12

### 变更

- Cookie 发送顺序改为会话 Cookie 在前。
- 诊断报告为每个接口附一条可直接执行的 curl。

### 移除

- 移除 0.0.11 引入的「先访问页面再发 AJAX」预热（后续证实并非必要条件）。

## 0.0.11

### 新增

- 诊断命令输出各接口的 HTTP 状态与服务端响应摘要。
- 请求头补充 `Accept-Language`。

## 0.0.10

### 新增

- 命令「XDOJ: 诊断接口连通性」：逐接口探活、输出服务端响应摘要并可复制。
- 错误信息附带服务端响应体摘要（Java 异常页会被提取）。

### 修复

- HTML 剥离时把 `<=` 误判为标签开头，导致内容丢失。

## 0.0.9

### 新增

- 提交接口（multipart/form-data）：`xdoj.submitEncoding` / `submitFields` /
  `submitFileField` / `submitFileContentType`。
- 从提交页 HTML 提取 `classId`（服务端渲染的隐藏字段，无独立接口）。
- 提交接口不返回 ID 时，以本地占位记录 + 轮询列表认领的方式跟踪状态。

### 修复

- **会话过期不做 401/403，而是 302 到站点根。** 原先跟随重定向会把登录页当成正常响应
  （题面甚至会被存成 `.pdf`）。改为手动处理重定向：命中过期地址时重新登录并重试一次。
  同时禁止把 HTML 页面当作 PDF/DOCX 落盘。
- `toEpochMs` 把带时区的 ISO 时间当作本地时间，导致整体偏移一个时区。

## 0.0.8

### 新增

- 提交记录接口（`submission/results.do`，jqGrid），按比赛查询。

### 变更

- 判定优先采用 `judgementText` 文案；数字码仅在无文案时使用，
  并在同时拿到码与文案时自动学习映射，未收录的码保持「未知」。
- 单位口径对齐：`submitTime` 按本地时间解析，`memory` 为 MB，`time` 为毫秒耗时。
- `xdoj.endpoints.submission` 默认留空，退化为扫描列表定位单条提交。

## 0.0.7

### 新增

- 题面下载接口，以及 `xdoj.downloadDir`（默认 `<工作区>/problems/`，留空则不落盘）。
- 题面类型判定：内容魔数 → 扩展名 → Content-Type → 文本嗅探；
  新增 `binary` 类型（`.doc` 等交给系统程序打开）。
- 文本题面按响应声明的 charset 解码。

### 修复

- `xdoj.referers` 原先整体替换，用户只改一项会导致其余接口不发 Referer，改为按 key 合并。

## 0.0.6

### 变更

- Referer 从全局单值改为 `xdoj.referers` 按接口配置，支持 `{endpoint}` / `{contestId}` 等占位符，
  留空则不发送。

## 0.0.5

### 新增

- 比赛题目接口（`contest/problems.do`），接口模板支持 `{account}` / `{userId}` / `{timestamp}`。

### 修复

- 题目字段按实测对齐：以 `userAcceptCount` 判断是否通过、`difficulty` 数值映射、
  `orderId` 用于比赛内排序。

## 0.0.4

### 变更

- 侧栏改为「比赛 → 题目」两级树，题目懒加载并缓存。
- 比赛列表按 jqGrid 协议请求；`problems: []` 解释为「未加载」而非「0 题」。
- 语言偏好改由 Cookie `preferred_lang` 传递，`xdoj.commonQueryParams` 默认清空。

## 0.0.3

### 新增

- 接入真实登录接口（`POST /xdoj-ssm/user/login.do`）。
- `xdoj.userAgent` / `xdoj.commonQueryParams`。

### 修复

- **登录失败被误判为成功。** 该接口失败时同样返回 HTTP 200 并下发 `JSESSIONID`，
  原先只检查是否拿到 Cookie。现改为优先依据响应体状态字段判定。
- 登录被拒时清除本地旧会话，避免状态栏持续显示「已登录」。

## 0.0.2

### 新增

- 账户密码登录，会话与凭据存入 SecretStorage；遇到 401/403 自动重新登录。
- 命令：登录 / 退出登录 / 设置密码 / 清除已保存的密码。

### 变更

- 配置项收敛为 `xdoj.endpoint` / `xdoj.account` / `xdoj.password` 三项。

## 0.0.1

初始版本。

- 侧栏题目列表与提交记录两个视图。
- 题面标签页：PDF（内置 pdf.js）、DOCX（本地打开）、TXT、HTML。
- 一键提交当前源文件，自动保存并推断题号。
- 提交状态轮询与通知；可离线运行的内置样例数据。
