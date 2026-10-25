# XDOJ 接口文档

本扩展实际用到的全部接口。所有路径都以 `{endpoint}` 为根（由 `xdoj.endpoint` 配置，
没有默认值），业务接口统一在 `/xdoj-ssm/` 下。下文示例用 `your-oj.example`
代替真实主机，照着敲时换成你自己的地址。

标注说明：**✅ 实测确认**（抓包 / 真实请求验证过）· **⚠️ 推断**（按响应形状容错，未逐一验证）

---

## 0. 总览

| # | 方法 | 路径 | 用途 | 认证 |
| --- | --- | --- | --- | --- |
| 1 | POST | `/xdoj-ssm/user/login.do` | 登录，换 `JSESSIONID` | 否 |
| 2 | GET | `/xdoj-ssm/login.jsp` | 登录页（仅诊断用） | 否 |
| 3 | POST | `/xdoj-ssm/contest/list.do` | 比赛列表（jqGrid） | 是 |
| 4 | POST | `/xdoj-ssm/team/selectContest.do` | **写「当前比赛」到 session** | 是 |
| 5 | GET | `/xdoj-ssm/contest/problems.do` | 某场比赛下的题目（jqGrid） | 是 |
| 6 | GET | `/xdoj-ssm/problem/downloadTextFile.do` | 题面附件下载（PDF/DOCX/TXT） | 是 |
| 7 | GET | `/xdoj-ssm/team/submit.do` | 提交页，刮 `classId` | 是 |
| 8 | POST | `/xdoj-ssm/submission/submit.do` | 提交源码（multipart） | 是 |
| 9 | POST | `/xdoj-ssm/submission/results.do` | 提交记录列表（jqGrid） | 是 |
| 10 | GET | — | 单条提交查询 | **不存在** |

**调用顺序**（必须遵守）：

```
1 登录
  → 3 比赛列表
    → 4 selectContest（每场比赛一次）
      → 5 比赛题目
        → 6 题面下载
        → 7 提交页 → 8 提交
        → 9 提交记录
```

第 4 步漏了，第 5 步会 **HTTP 500**（见 §4）。

---

## 1. 通用约定

### 1.1 认证

纯 Cookie 认证，没有 token。

```
Cookie: JSESSIONID=abcdef0123456789; preferred_lang=zh_CN
```

- `JSESSIONID` 由登录响应（或任意响应）的 `Set-Cookie` 给出，**每次请求都可能被刷新**，要跟着更新。
- `preferred_lang=zh_CN` 决定返回中文文案（`judgementText` 之类）。它**走 Cookie，不是 query 参数**。
- 会话存进 VS Code 的加密凭据库（`SecretStorage`），不落 `settings.json`。

### 1.2 请求头

业务请求（AJAX 形态）：

```http
Accept: application/json, text/javascript, */*; q=0.01
X-Requested-With: XMLHttpRequest
Accept-Language: zh-CN,zh;q=0.9
User-Agent: Mozilla/5.0 (X11; Linux x86_64) ... Chrome/131.0.0.0 Safari/537.36
Referer: <按接口不同，见各节>
```

页面导航形态（仅预热里的 GET 步骤）：

```http
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8
Accept-Language: zh-CN,zh;q=0.9
Upgrade-Insecure-Requests: 1
```

`Referer` **每个接口不同**，不能共用一个值（见各节）。`xdoj.referers` 可以逐个覆盖。

### 1.3 表单编码

jqGrid 接口和登录都用：

```http
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

### 1.4 jqGrid 协议

`contest/list.do` 和 `submission/results.do` 都是 jqGrid 服务端分页，请求体固定：

```
_search=false&nd=<毫秒时间戳>&rows=100&page=1&sidx=&sord=asc
```

响应固定外壳：

```json
{
  "totalCount": 12,
  "totalpages": 2,
  "page": 2,
  "data": [ ... ]
}
```

分页参数不影响扩展：`rows=100` 尽量一次拿完，扩展不翻页。

### 1.5 错误语义（重要）

| 现象 | 含义 | 扩展的处理 |
| --- | --- | --- |
| **302 → `/xdoj-ssm/`** | 登录态失效 | 自动重新登录 + 重试一次 |
| 301/302/303（其它目标） | 普通跳转 | 按浏览器习惯降级成 GET 跟随（最多 5 跳） |
| 307/308 | 普通跳转 | 保留方法和 body 跟随 |
| 401 / 403 | token 过期（别的 OJ） | 重新登录 + 重试 |
| 5xx | 服务端错误 | 延迟后重试，**只对幂等请求**（不会重复提交） |
| 200 + `{"error":1}` | 登录被拒 | 视为失败并清空会话 |
| 200 + `{"code":1,"info":"..."}` | 提交被拒 | 视为失败，把 `info` 显示给用户 |

⚠️ **XDOJ 失效时是 302 到站点根，不是 401/403**。如果用 `redirect: 'follow'`，
会静默跟到登录页拿到 `200`，然后被当成正常数据——题面下载甚至会把登录页存成 `.pdf`。
所以扩展一律 `redirect: 'manual'` 自己判定。

⚠️ **登录失败也返回 HTTP 200，而且会给一个新的 `JSESSIONID`**。
只看「有没有 Cookie」会误判成功，必须看响应体的 `error` 字段。

5xx 的 Tomcat 错误页里带 Java 异常，扩展会抽这两段给用户看：

```html
<b>消息</b> ... <b>根本原因</b> ...
```

---

## 2. 登录

### 2.1 `POST /xdoj-ssm/user/login.do` ✅

| 项 | 值 |
| --- | --- |
| Body | `preferLanguage=zh_CN&userId=<账户>&password=<密码>` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Referer | `{endpoint}/xdoj-ssm/login.jsp` |
| 认证 | 不需要 |

**成功**：

```http
HTTP/1.1 200 OK
Content-Type: application/json;charset=UTF-8
Set-Cookie: JSESSIONID=ABC123; Path=/xdoj-ssm; HttpOnly
```

```json
{ "error": 0, "userType": 0 }
```

**失败**（注意仍然是 200）：

```http
HTTP/1.1 200 OK
Set-Cookie: JSESSIONID=NEW-BUT-USELESS; Path=/xdoj-ssm; HttpOnly
```

```json
{ "error": 1 }
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `error` | number | `0` 成功，非 0 失败 |
| `userType` | number | 用户类型，扩展不关心 |

### 2.2 `GET /xdoj-ssm/login.jsp` ⚠️

**只用于诊断命令**，正常流程不请求。作用是对照「浏览器怎么登录」：
打开登录页建立会话，再把页面里的表单字段打出来，看扩展是不是漏发了某个字段
（例如 `userType`）。配置项 `xdoj.endpoints.loginPage`。

---

## 3. 比赛列表

### `POST /xdoj-ssm/contest/list.do` ✅

| 项 | 值 |
| --- | --- |
| Body | jqGrid：`_search=false&nd=<ms>&rows=100&page=1&sidx=&sord=asc` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Referer | `{endpoint}/xdoj-ssm/team/contests.do` |

**响应**：

```json
{
  "totalCount": 1,
  "totalpages": 1,
  "page": 1,
  "data": [
    {
      "id": "demo-contest",
      "title": "示例比赛（进行中）",
      "description": "示例比赛说明",
      "startTime": "2026-01-05 14:00:00",
      "endTime": "2026-01-12 23:59:00",
      "started": true,
      "running": true,
      "active": true,
      "status": 1,
      "statusString": "Ready",
      "judging": true,
      "type": 0,
      "showRankList": true,
      "penaltyTime": 0,
      "timeBeforeStopJudge": 0,
      "maxOutputLines": 0,
      "maxOutputSize": 256,
      "creatorId": "demo-teacher",
      "classes": [],
      "problems": [],
      "languages": [
        { "id": 2, "name": "GNU C/C++", "compileCmdline": "gcc.exe {srcfile} -lstdc++ -std=c++17 -o {basename}.exe" }
      ]
    }
  ]
}
```

字段用法：

| 字段 | 说明 |
| --- | --- |
| `id` | 比赛 ID，后续 `selectContest` / `contest/problems.do` 都要它 |
| `title` | 侧栏第一级标题 |
| `startTime` / `endTime` | `YYYY-MM-DD HH:mm:ss`，**本地时间**，不带时区 |
| `started` / `running` / `active` | 扩展按此分组排序：进行中 → 已结束 → 未开始；同级内按 `id` 倒序 |
| `statusString` | 服务端状态文案（`Ready` 等），显示在 tooltip |
| `problems` | **这里永远是空数组**，题目要单独请求（§5）；`problems: []` 不代表「0 题」 |
| `languages[].id` | 提交时的 `languageId`，`2` = GNU C/C++ |

---

## 4. 选择比赛（预热）✅

### `POST /xdoj-ssm/team/selectContest.do`

| 项 | 值 |
| --- | --- |
| Body | `contestId=<比赛ID>` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Referer | `{endpoint}/xdoj-ssm/team/contests.do` |
| 响应 | 忽略（JSON，内容不重要） |

### 为什么必须有这一步

浏览器点比赛名时走的是：

```
GET  team/contests.do            页面
POST team/selectContest.do        ← 把「当前比赛」写进 session
GET  team/problems.do            页面
GET  contest/problems.do         AJAX，此时才正常
```

`contest/problems.do` 从 session 里取「当前比赛」**且没有判空** ——
没建好就直接 `ClassCastException` → **HTTP 500**。扩展不能跳过这一步。

### 规则

- **每场比赛一次**：选 `demo-contest` 和选 `demo-contest-2` 是不同的 session 状态，换比赛要重做。
- **换会话也要重做**：重新登录后 session 是新的，之前的预热作废。
- 预热失败不阻塞后续请求（只记日志）。
- 可用 `xdoj.prewarmSteps` 自定义整个步骤序列；写 `[]` 表示不预热。

浏览器实际还会打开 `team/contests.do`、`team/problems.do` 两个页面，但**扩展不请求它们**：
它们只负责渲染，不写状态，真正写状态的就是 `selectContest.do`。

---

## 5. 比赛下的题目

### `GET /xdoj-ssm/contest/problems.do` ✅

| 项 | 值 |
| --- | --- |
| Query | `contestId=<比赛ID>&userId=<账户>&_search=false&nd=<ms>&rows=100&page=1&sidx=&sord=asc` |
| Referer | `{endpoint}/xdoj-ssm/team/problems.do` |
| 前置 | **必须先 `POST selectContest.do`**（§4），否则 500 |

> 注意：参数在 **query** 里，请求体为空 —— 和另外两个 jqGrid 接口（POST + body）不同。

**响应**：

```json
{
  "totalCount": 7,
  "totalpages": 1,
  "page": 1,
  "data": [
    {
      "id": "demo-problem-a",
      "orderId": 0,
      "title": "计算球体重量",
      "difficulty": 1,
      "category": 1,
      "categoryName": "基本计算",
      "tags": [{ "id": "demo-tag", "name": "基本计算" }],
      "timeLimit": 1,
      "memoryLimit": 100,
      "acceptSubmit": 37059,
      "totalSubmit": 102150,
      "userAcceptCount": 1,
      "points": 0,
      "solutionType": 0,
      "text": [],
      "textType": "",
      "visibleForAll": false,
      "ignoreCase": false,
      "ignoreEmptyLine": false,
      "mainProgram": [],
      "creatorId": "demo-teacher"
    }
  ]
}
```

| 字段 | 类型 | 单位 / 说明 |
| --- | --- | --- |
| `id` | number | 题号 |
| `orderId` | number | 比赛内序号，**从 0 开始**（对应 A/B/C…），扩展按它排序 |
| `title` | string | 题目标题 |
| `difficulty` | number | `0` 未评定 · `1` 入门 · `2` 简单 · `3` 中等 · `4` 困难 · `5` 噩梦 |
| `tags[].name` | string | 标签 |
| `timeLimit` | number | **秒**（扩展内部转成 ms 显示） |
| `memoryLimit` | number | **MB** |
| `acceptSubmit` / `totalSubmit` | number | 通过数 / 提交数 |
| `userAcceptCount` | number | **>0 即表示当前用户已通过**（是「通过次数」，不是布尔值），侧栏打勾 |
| `points` | number | 分值 |
| `text` | array | **恒为空**，题面走单独接口（§6） |

---

## 6. 题面下载

### `GET /xdoj-ssm/problem/downloadTextFile.do?problemId=<题号>` ✅

| 项 | 值 |
| --- | --- |
| Query | `problemId=<题号>` |
| Referer | `{endpoint}/xdoj-ssm/` |
| 响应 | **二进制**（不是 JSON） |

**响应头**：

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment;filename=%E8%AE%A1%E7%AE%97%E7%90%83%E4%BD%93%E9%87%8D%E9%87%8F.pdf
```

- 返回 PDF / DOCX / DOC / TXT 之一，**类型由内容决定**，不能只信扩展名。
- 文件名可能有两种写法：`filename="x.pdf"`（可能已 URL 编码）和
  RFC 5987 的 `filename*=UTF-8''x.pdf`。

**类型判定顺序**（`detectStatementFile`）：

1. **魔数优先且有否决权**：`%PDF-` → PDF；`PK\x03\x04` → DOCX；但内容像 HTML 时**否决** PDF/DOCX
2. `Content-Disposition` 的文件名后缀
3. `Content-Type`
4. 文本嗅探

⚠️ **必须防「登录页冒充题面」**：会话失效时这个接口会 302 到登录页，
跟随后得到 HTTP 200 + HTML。不拦住就会把登录页存成 `.pdf`，界面上还显示成功。
所以拿到 PDF/DOCX 但内容是 HTML 时，扩展直接报错并提示重新登录。

---

## 7. 提交页（刮隐藏字段）

### `GET /xdoj-ssm/team/submit.do?problemId=<题号>` ✅

| 项 | 值 |
| --- | --- |
| Query | `problemId=<题号>` |
| Referer | `{endpoint}/xdoj-ssm/team/problems.do` |
| 响应 | HTML |

**为什么需要**：`classId`（例如 `demo-class`）没有独立接口，
是服务端渲染进这个页面的隐藏字段，只能 GET 下来刮。

```html
<input type="hidden" value="demo-class" id="classId" name="classId" />
<input type="file" id="sourceFile" name="sourceFile"/>
```

⚠️ **属性顺序不固定**：`value` 写在 `name` **前面**，不能用一条正则一次抓完，
必须逐个属性解析。`type="file"` 的 input 没有 `value`，不能被当成隐藏字段覆盖成空串。

抓到的值**按比赛缓存**，切换比赛或重新登录后清空。`xdoj.classId` 填了就跳过这一步。

---

## 8. 提交

### `POST /xdoj-ssm/submission/submit.do` ✅

| 项 | 值 |
| --- | --- |
| Content-Type | `multipart/form-data; boundary=...`（由运行时生成） |
| Referer | `{endpoint}/xdoj-ssm/team/submit.do?problemId=<题号>` |

**请求体**：

```
solutionType=0
contestId=<比赛ID>
userId=<账户>
classId=<班级ID>
problemId=<题号>
languageId=2
sourceCode=                                    ← 空
sourceFile=<文件部分：<题号>.cpp, text/x-c++src, 内容为源码原始字节>
```

| 字段 | 值来源 | 说明 |
| --- | --- | --- |
| `solutionType` | 固定 `0` | 普通提交 |
| `contestId` | 题目所属比赛 | 必填 |
| `userId` | 账户 | 学号 |
| `classId` | §7 刮取 | 表单隐藏字段 |
| `problemId` | 当前题目 | |
| `languageId` | `xdoj.submitLanguage`（默认 `2`） | `2` = GNU C/C++ |
| `sourceCode` | 空 | 页面上它是 **Ace 编辑器的 `<div>`，不是 input**，走文件上传时为空 |
| `sourceFile` | **源码原始字节** | 和浏览器 `<input type="file">` 等价，编码不动 |

**源码编码**：文件是 GB2312 / GBK / GB18030 也**按原始字节上传**，不转 UTF-8。
需要服务端只吃 UTF-8 时把 `xdoj.submitTranscode` 设成 `utf8`。

**响应**：

```json
{ "code": 0, "info": "success" }
```

| 字段 | 说明 |
| --- | --- |
| `code` | `0` 成功，非 `0` 失败 |
| `info` | 失败原因（如「比赛已结束」），成功时是 `success` |
| `id` / `submissionId` | **没有**。响应里不带提交 ID |

⚠️ 因为拿不到 ID，扩展只能：先放一条本地占位记录 → 轮询 §9 列表，
按「同一道题 + 提交时间在 5 分钟窗口内」认领最新那条。

---

## 9. 提交记录

### `POST /xdoj-ssm/submission/results.do?contestId=<比赛ID>&userId=<账户>` ✅

| 项 | 值 |
| --- | --- |
| Query | `contestId=<比赛>`、`userId=<账户>` |
| Body | jqGrid：`_search=false&nd=<ms>&rows=100&page=1&sidx=&sord=asc` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Referer | `{endpoint}/xdoj-ssm/team/results.do` |

**响应**：

```json
{
  "totalCount": 12,
  "totalpages": 2,
  "page": 1,
  "data": [
    {
      "id": "demo-submission-3",
      "contestId": "demo-contest",
      "problemId": "demo-problem-b",
      "problem": { "id": "demo-problem-b", "orderId": 0, "title": "温度转换", "tags": [{ "id": "demo-tag", "name": "基本计算" }] },
      "judgement": 1,
      "judgementText": "正确",
      "languageId": 2,
      "language": { "id": 2, "name": "GNU C/C++", "exefileSuffix": "" },
      "submitTime": "2026-01-06 19:35:57",
      "time": 0,
      "memory": 0,
      "points": 100.0,
      "userId": "demo-account",
      "userName": "",
      "classId": "",
      "judgeTime": "",
      "jugeId": "",
      "preprocessResult": 0,
      "sourceCode": [],
      "sourceCodeObj": {},
      "sourceCodeStr": "",
      "sourceFileName": ""
    }
  ]
}
```

### 字段口径（这里最容易踩坑）

| 字段 | 真实含义 | 陷阱 |
| --- | --- | --- |
| `judgement` | 判定**数字码** | `1` = 正确；其它码没有官方文档，扩展从 `judgementText` **反向学习**映射 |
| `judgementText` | 判定**文案** | 优先用它，比数字码可靠 |
| `submitTime` | 提交时间，`YYYY-MM-DD HH:mm:ss` | **本地时间，不带时区**，按北京时间解析 |
| `time` | **运行耗时（毫秒）** | ⚠️ **不是时间戳**。当时间戳会算出 1970 年。扩展只接受 `< 1e9` 的值当耗时 |
| `memory` | 内存占用，**MB** | 不是 KB |
| `points` | 得分 | 不是「通过题数」 |
| `language` | 对象 `{id, name}` | 取 `name` 显示，不是字符串 |
| `problem.title` | 题目标题 | 和 `problemId` 一起给 |
| `id` | 提交 ID | 与提交数字一致的整数 |

### 单条提交查询

**不存在这个接口**（`xdoj.endpoints.submission` 留空）。
`results.do` 一行就带齐了判定、耗时、内存、编译信息，所以扩展直接扫列表按 `id` 找。

### `GET /xdoj-ssm/submission/listJudge.do?submissionId=<提交ID>` ✅

某次提交对应的**评测记录**。逐测试点结果先要靠它换出 `judgeId`。

| 项 | 值 |
| --- | --- |
| Query | `submissionId=<提交>`, `_search=false`, `nd=<ms>`, `rows=5`, `page=1`, `sidx=`, `sord=asc` |
| Referer | `{endpoint}/xdoj-ssm/team/viewJudge.do?submissionId=<提交>` |
| 头 | `X-Requested-With: XMLHttpRequest` |

**响应**：

```json
{"totalCount":1,"totalpages":1,"page":1,"data":[
  {"compileOutput":[],"compileOutputStr":"","endTime":"2026-01-10 18:43:07",
   "id":"demo-judge","judgement":1,"judgementText":"正确","memory":0,"points":100,
   "preprocessResult":0,"problemId":0,"startTime":"2026-01-10 18:43:07",
   "submissionId":"demo-submission","time":0}]}
```

⚠️ **`data[0].id` 是 judgeId，不是提交 ID**（demo-judge vs demo-submission）。
`problemId` 这里是 `0`，没有意义，别拿它去定位题目。

### `POST /xdoj-ssm/submission/listAllJudgeRun.do` ✅

**逐测试点**结果。

| 项 | 值 |
| --- | --- |
| Body | `judgeId=demo-judge` |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Referer | `{endpoint}/xdoj-ssm/team/viewJudge.do?submissionId=<提交ID>` |

**响应**：

```json
{"totalCount":3,"totalpages":1,"page":1,"data":[
  {"id":"<行ID>","judgeId":0,"memory":0,"output":[],"result":1,"runTime":14,
   "testcaseDescription":"","testcaseId":"<测试点ID>"}]}
```

| 字段 | 真实含义 | 陷阱 |
| --- | --- | --- |
| `result` | 该测试点结果码 | **只有 `1` 有实证**（通过），其余码未知，扩展原样显示不猜 |
| `runTime` | 该测试点耗时（毫秒） | 不是时间戳 |
| `memory` | 内存，**MB**；实测恒为 `0` | 和 `results.do` 一样不给真实值 |
| `testcaseId` | 测试点编号 | 不是行 ID |
| `judgeId` | 行里的 `judgeId` 恒为 `0` | 真正的 judgeId 在外层/`listJudge.do` 里 |

---

## 10. 配置项 ↔ 接口 对照

| 配置项 | 默认值 | 对应接口 |
| --- | --- | --- |
| `xdoj.endpoint` | **空**（必填） | 所有接口的根 |
| `xdoj.endpoints.login` | `/xdoj-ssm/user/login.do` | §2.1 |
| `xdoj.endpoints.loginPage` | `/xdoj-ssm/login.jsp` | §2.2 |
| `xdoj.endpoints.contests` | `/xdoj-ssm/contest/list.do` | §3 |
| `xdoj.endpoints.contestProblems` | `/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}&_search=false&nd={timestamp}&rows=100&page=1&sidx=&sord=asc` | §5 |
| `xdoj.endpoints.statement` | `/xdoj-ssm/problem/downloadTextFile.do?problemId={id}` | §6 |
| `xdoj.endpoints.submitPage` | `/xdoj-ssm/team/submit.do?problemId={problemId}` | §7 |
| `xdoj.endpoints.submit` | `/xdoj-ssm/submission/submit.do` | §8 |
| `xdoj.endpoints.submissions` | `/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}` | §9 |
| `xdoj.endpoints.submission` | 空 | §10 单条查询，不存在 |
| `xdoj.endpoints.problem` | 空 | 题目详情接口，不存在（用 §5 的列表字段） |
| `xdoj.prewarmSteps` | 一条 `POST selectContest.do` | §4 |
| `xdoj.referers` | 见 §1.2 | 按接口设 Referer |
| `xdoj.extraCookies` | `preferred_lang=zh_CN` | §1.1 |
| `xdoj.submitFields` / `submitFileField` | §8 的表单字段 | §8 |
| `xdoj.submitLanguage` | `2` | §8 的 `languageId` |
| `xdoj.classId` | 空（自动刮） | §7 |

### 占位符

| 占位符 | 含义 |
| --- | --- |
| `{endpoint}` | OJ 根地址，**原样替换**（不做 URL 编码） |
| `{account}` / `{userId}` | 账户 / 学号 |
| `{contestId}` | 比赛 ID |
| `{problemId}` / `{id}` | 题号 |
| `{classId}` | 班级编号（刮到的） |
| `{language}` / `{languageId}` | 语言 ID |
| `{timestamp}` | 当前毫秒时间戳（jqGrid 的 cache buster） |
| `{code}` / `{filename}` | 源码文本 / 文件名 |

---

## 11. 手工复现（curl）

```bash
BASE=http://your-oj.example/xdoj-ssm
ACC=<学号>
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
JSON='Accept: application/json, text/javascript, */*; q=0.01'
XRW='X-Requested-With: XMLHttpRequest'
FORM='Content-Type: application/x-www-form-urlencoded; charset=UTF-8'

# 1. 登录 —— 从响应头抄 JSESSIONID
curl -i -s -X POST "$BASE/user/login.do" -H "$FORM" \
  -H "Referer: http://your-oj.example/xdoj-ssm/login.jsp" -H "User-Agent: $UA" \
  --data "preferLanguage=zh_CN&userId=$ACC&password=<密码>"

SID=<从上一步抄>
CK="Cookie: JSESSIONID=$SID; preferred_lang=zh_CN"

# 3. 比赛列表
curl -s -X POST "$BASE/contest/list.do" -H "$JSON" -H "$XRW" -H "$FORM" \
  -H "Referer: http://your-oj.example/xdoj-ssm/team/contests.do" -H "User-Agent: $UA" -H "$CK" \
  --data '_search=false&nd=1&rows=100&page=1&sidx=&sord=asc'

# 4. 选比赛 —— 漏了它第 5 步必 500
curl -s -X POST "$BASE/team/selectContest.do" -H "$FORM" \
  -H "Referer: http://your-oj.example/xdoj-ssm/team/contests.do" -H "User-Agent: $UA" -H "$CK" \
  --data 'contestId=demo-contest'

# 5. 比赛题目
curl -s "$BASE/contest/problems.do?contestId=demo-contest&userId=$ACC&_search=false&nd=1&rows=100&page=1&sidx=&sord=asc" \
  -H "$JSON" -H "$XRW" -H "Referer: http://your-oj.example/xdoj-ssm/team/problems.do" \
  -H "User-Agent: $UA" -H "$CK"

# 6. 题面（-o 存原文件，别用 -i 混进响应头）
curl -s -D - -o problem.pdf "$BASE/problem/downloadTextFile.do?problemId=demo-problem-a" \
  -H "Referer: http://your-oj.example/xdoj-ssm/" -H "User-Agent: $UA" -H "$CK"

# 7. 提交页（看 classId）
curl -s "$BASE/team/submit.do?problemId=demo-problem-a" \
  -H "Referer: http://your-oj.example/xdoj-ssm/team/problems.do" -H "User-Agent: $UA" -H "$CK"

# 9. 提交记录
curl -s -X POST "$BASE/submission/results.do?contestId=demo-contest&userId=$ACC" \
  -H "$JSON" -H "$XRW" -H "$FORM" \
  -H "Referer: http://your-oj.example/xdoj-ssm/team/results.do" -H "User-Agent: $UA" -H "$CK" \
  --data '_search=false&nd=1&rows=100&page=1&sidx=&sord=asc'
```

`tools/curl_steps.sh` 里有同一份清单的可执行版本。

---

## 12. 已知未确认 ⚠️

| 项 | 现状 |
| --- | --- |
| `judgement` 完整数字码表 | 只有 `1 = 正确` 有实证。其它码靠 `judgementText` 反向学习，遇到「只有数字码没有文案」的行会显示 `未知` 并保留原始码 |
| 提交响应里的提交 ID | 确认没有。只能靠轮询列表认领 |
| 题目详情接口 | 未找到。暂用 §5 列表里的字段（标题、限时、内存够用） |
| 比赛题目 `orderId` 从 0 还是 1 开始 | 观测到 `0`；扩展只按它排序，不假设起点 |
