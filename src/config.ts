import * as vscode from 'vscode';
import type { SubmitEncoding, SubmitTranscode } from './api/types';
import type { HttpTransport } from './api/transport';

export type DocxPreviewMode = 'office-online' | 'download';
export type OpenColumnMode = 'active' | 'beside';
export type LoginContentType = 'json' | 'form';

/**
 * 默认 OJ 地址：**空**。
 *
 * 这里以前硬编码着某个学校 OJ 的 IP。开源之后那是别人的私事，而且会让人
 * 误以为「地址已经填好了」——首次运行时由 `offerEndpointSetup` 引导填写。
 */
export const DEFAULT_ENDPOINT = '';

export interface XdojConfig {
  /** OJ 站点根地址，所有相对路径都拼在它后面。 */
  endpoint: string;
  /**
   * HTTP 传输层。
   * `fetch` 用 Node 内置的 undici（默认）；`node` 用 node:http 逐字节控制，
   * 行为最接近 curl —— 遇到对 undici 敏感的服务器时可以切换试试。
   */
  httpTransport: HttpTransport;
  /** 登录账户。 */
  account: string;
  /** 明文写在 settings.json 里的密码；留空则回退到加密凭据库。 */
  password: string;

  endpoints: {
    login: string;
    /** 登录页。诊断用它模拟「先开页面再登录」的浏览器流程。 */
    loginPage: string;
    /** 比赛列表（jqGrid）。留空表示这个 OJ 不分比赛，走扁平题目列表。 */
    contests: string;
    /** 某场比赛下的题目。 */
    contestProblems: string;
    problems: string;
    problem: string;
    /** 题面附件下载接口。 */
    statement: string;
    /** 提交页（用来刮 classId 这类隐藏字段）。 */
    submitPage: string;
    submit: string;
    submission: string;
    submissions: string;
    /** 某次提交对应的评测记录（jqGrid GET），里面就有 `judgeId`。 */
    judgeList: string;
    /** 单次评测的详情页。`judgeList` 拿不到 judgeId 时的兜底（从页面里刮）。 */
    judgePage: string;
    /** 逐测试点结果（jqGrid）。 */
    judgeRuns: string;
  };
  /** 比赛列表请求体（jqGrid 协议）。 */
  contestListTemplate: Record<string, string>;
  /** 提交记录列表请求体（同一套 jqGrid 协议）。 */
  submissionListTemplate: Record<string, string>;

  loginPayload: Record<string, string>;
  loginContentType: LoginContentType;
  /** token 放在哪个请求头，默认 Authorization。 */
  tokenHeader: string;
  /** token 前缀，默认 "Bearer "；OJ 直接收裸 token 时留空。 */
  tokenPrefix: string;

  useMockData: boolean;
  submitPayload: Record<string, string>;
  /** 提交请求体怎么编码。XDOJ 是 multipart。 */
  submitEncoding: SubmitEncoding;
  /** multipart 下的普通表单字段（值支持占位符）。 */
  submitFields: Record<string, string>;
  /** 源码作为文件部分发到哪个字段名；留空则改用 submitFields 里的 {code}。 */
  submitFileField: string;
  /** 源码文件部分的 Content-Type。 */
  submitFileContentType: string;
  /**
   * 上传前要不要把源码重新编码成 UTF-8。
   * `none`（默认）原样上传磁盘字节，`utf8` 才转码。
   */
  submitTranscode: SubmitTranscode;
  submitLanguage: string;
  /** 班级编号。留空时会尝试从提交页 HTML 里刮。 */
  classId: string;
  requestHeaders: Record<string, string>;
  /** 附加到所有业务请求 URL 上的 query 参数。 */
  commonQueryParams: Record<string, string>;
  /** 额外附加到 Cookie 头上的键值对。 */
  extraCookies: Record<string, string>;
  /** 请求时用的 User-Agent。留空则不发送。 */
  userAgent: string;
  /** 按接口配置的 Referer 模板。键名同 `endpoints`。留空的接口不发 Referer。 */
  referers: Record<string, string>;
  /**
   * 登录态失效时服务端会 302 到这里（XDOJ 是站点根 `/xdoj-ssm/`）。
   * 扩展据此判断「该重新登录了」。
   */
  sessionExpiredRedirect: string;
  /**
   * 建立会话状态要按顺序执行的请求。
   *
   * XDOJ 的 `contest/problems.do` 会从 session 里取「当前比赛」，而且没判 null ——
   * 状态没建好时直接 `ClassCastException`。而「当前比赛」是靠
   * `POST team/selectContest.do`（body: `contestId=<比赛ID>`）写进 session 的。
   * 页面本身不写状态，只是它们的 JS 会发这个请求。
   *
   * 每场比赛预热一次；换比赛或换会话都会重做。
   */
  prewarmSteps: PrewarmStep[];
  /** 关掉则完全跳过预热。 */
  prewarmEnabled: boolean;
  /** 5xx 时是否自动重试（只对 GET/HEAD，避免重复提交）。 */
  retryOnServerError: boolean;
  retryDelayMs: number;
  /**
   * 题面文件下载目录。
   * 相对路径按工作区根目录解析；留空则不落盘，只在标签页里渲染。
   */
  downloadDir: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  docxPreview: DocxPreviewMode;
  problemOpenColumn: OpenColumnMode;
  requestTimeoutMs: number;
}

export const CONFIG_SECTION = 'xdoj';

const DEFAULT_SUBMIT_PAYLOAD: Record<string, string> = {
  problemId: '{problemId}',
  language: '{language}',
  code: '{code}',
};

// XDOJ（Spring SSM）的登录表单字段。
const DEFAULT_LOGIN_PAYLOAD: Record<string, string> = {
  preferLanguage: 'zh_CN',
  userId: '{account}',
  password: '{password}',
};

// 实测下来 XDOJ 的语言偏好是走 Cookie（`preferred_lang=zh_CN`）的，不是 query 参数，
// 所以这里默认留空。需要时用户自己加。
const DEFAULT_COMMON_QUERY: Record<string, string> = {};

// 抓包看到的请求里带着 preferred_lang，业务接口靠它决定返回哪种语言。
const DEFAULT_EXTRA_COOKIES: Record<string, string> = {
  preferred_lang: 'zh_CN',
};

// jqGrid 的服务端分页协议。rows 给大一点，尽量一次拿完比赛。
const DEFAULT_CONTEST_LIST_BODY: Record<string, string> = {
  _search: 'false',
  nd: '{timestamp}',
  rows: '100',
  page: '1',
  sidx: '',
  sord: 'asc',
};

/**
 * 浏览器打开「某场比赛的题目」之前实际走的请求序列。
 *
 * 少中间那步 `selectContest.do`，服务端 session 里就没有「当前比赛」，
 * `contest/problems.do` 取出来强转就会抛 ClassCastException。
 */
const DEFAULT_PREWARM_STEPS: PrewarmStep[] = [
  {
    method: 'POST',
    url: '/xdoj-ssm/team/selectContest.do',
    body: 'contestId={contestId}',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    referer: '{endpoint}/xdoj-ssm/team/contests.do',
  },
];

// 提交记录接口是同一套协议。
const DEFAULT_SUBMISSION_LIST_BODY: Record<string, string> = { ...DEFAULT_CONTEST_LIST_BODY };

/**
 * XDOJ 提交表单的隐藏字段，照抄抓包。
 *
 * 注意 `sourceCode`：它在页面上是个 **Ace 编辑器的 div**（不是 input），
 * 由 JS 读内容后 append 进去。抓包里它是空的（因为走的是文件上传），这里保持一致。
 * 想把代码放进 sourceCode 而不是文件，把 `submitFileField` 留空、
 * 并把这里的 sourceCode 改成 `{code}`。
 */
const DEFAULT_SUBMIT_FIELDS: Record<string, string> = {
  solutionType: '0',
  contestId: '{contestId}',
  userId: '{account}',
  classId: '{classId}',
  problemId: '{problemId}',
  languageId: '{language}',
  sourceCode: '',
};

// 有些 Java 后端会看 UA（移动端 / 桌面端分流），带一个正常的浏览器 UA 最保险。
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 部分 SSM 应用会校验 Referer 做简单的防盗链 / CSRF 防护。
// 每个接口的来源页天然不同，所以按接口分别配置。
const DEFAULT_REFERERS: Record<string, string> = {
  login: '{endpoint}/xdoj-ssm/login.jsp',
  loginPage: '{endpoint}/xdoj-ssm/',
  contests: '{endpoint}/xdoj-ssm/team/contests.do',
  contestProblems: '{endpoint}/xdoj-ssm/team/problems.do',
  // 下面这些接口还没确认，先给站点前缀兜底。
  problems: '{endpoint}/xdoj-ssm/',
  problem: '{endpoint}/xdoj-ssm/',
  statement: '{endpoint}/xdoj-ssm/',
  submit: '{endpoint}/xdoj-ssm/team/submit.do?problemId={problemId}',
  submitPage: '{endpoint}/xdoj-ssm/team/problems.do',
  submission: '{endpoint}/xdoj-ssm/team/results.do',
  submissions: '{endpoint}/xdoj-ssm/team/results.do',
  judgeList: '{endpoint}/xdoj-ssm/team/viewJudge.do?submissionId={id}',
  judgePage: '{endpoint}/xdoj-ssm/team/viewJudge.do?submissionId={id}',
  judgeRuns: '{endpoint}/xdoj-ssm/team/viewJudge.do?submissionId={id}',
};

/** 预热步骤。用户在设置里写空数组表示「不预热」。 */
export interface PrewarmStep {
  method: string;
  url: string;
  /** 请求体模板（form-urlencoded）。可用 `{contestId}` 等占位符。 */
  body?: string;
  contentType?: string;
  /** 这一步的 Referer。不写则沿用上一步的 URL。 */
  referer?: string;
}

function asPrewarmSteps(value: unknown): PrewarmStep[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_PREWARM_STEPS];
  }
  if (value.length === 0) {
    return [];
  }
  const steps: PrewarmStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
    if (!url) {
      continue;
    }
    const step: PrewarmStep = {
      method: typeof record['method'] === 'string' ? record['method'].toUpperCase() : 'GET',
      url,
    };
    if (typeof record['body'] === 'string') {
      step.body = record['body'];
    }
    if (typeof record['contentType'] === 'string') {
      step.contentType = record['contentType'];
    }
    if (typeof record['referer'] === 'string') {
      step.referer = record['referer'];
    }
    steps.push(step);
  }
  return steps.length > 0 ? steps : [...DEFAULT_PREWARM_STEPS];
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    } else if (raw !== null && raw !== undefined) {
      out[key] = String(raw);
    }
  }
  return out;
}

/**
 * 按 key 合并默认值 —— 用于 `xdoj.referers` 这种「每个 key 相互独立」的映射。
 *
 * 用户只覆盖其中一个接口时，其余接口必须继续用默认值；
 * 早期版本是整个对象替换，结果改一个 Referer 会让其它接口静默变成不发 Referer。
 * 想把某个接口显式置空，就把那个 key 设成空字符串。
 */
function mergeByKey(value: unknown, defaults: Record<string, string>): Record<string, string> {
  const parsed = asRecord(value);
  return { ...defaults, ...parsed };
}

/**
 * 整体替换 —— 用于 `loginPayload` / `submitPayload` / `contestListTemplate`。
 *
 * 这些模板描述的是**整个请求体**，用户写出来就是完整定义，
 * 再掺进默认字段会发出服务端没预期的参数。
 */
function replaceOrDefaults(value: unknown, defaults: Record<string, string>): Record<string, string> {
  const parsed = asRecord(value);
  return Object.keys(parsed).length > 0 ? parsed : { ...defaults };
}

/** 去掉末尾斜杠，方便和相对路径拼接。 */
function normalizeEndpoint(raw: string): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

export function getConfig(): XdojConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    endpoint: normalizeEndpoint(c.get<string>('endpoint', DEFAULT_ENDPOINT)),
    httpTransport: c.get<HttpTransport>('httpTransport', 'fetch'),
    account: (c.get<string>('account', '') ?? '').trim(),
    password: c.get<string>('password', '') ?? '',

    endpoints: {
      login: c.get<string>('endpoints.login', '/xdoj-ssm/user/login.do'),
      loginPage: c.get<string>('endpoints.loginPage', '/xdoj-ssm/login.jsp'),
      contests: c.get<string>('endpoints.contests', '/xdoj-ssm/contest/list.do'),
      contestProblems: c.get<string>(
        'endpoints.contestProblems',
        '/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}' +
          '&_search=false&nd={timestamp}&rows=100&page=1&sidx=&sord=asc',
      ),
      problems: c.get<string>('endpoints.problems', '/api/problems'),
      // 留空表示不用详情接口：比赛题目列表里已经够用了。
      problem: c.get<string>('endpoints.problem', ''),
      statement: c.get<string>(
        'endpoints.statement',
        '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
      ),
      submitPage: c.get<string>(
        'endpoints.submitPage',
        '/xdoj-ssm/team/submit.do?problemId={problemId}',
      ),
      submit: c.get<string>('endpoints.submit', '/xdoj-ssm/submission/submit.do'),
      // 留空表示没有单条查询接口，改用扫描提交列表的方式定位。
      submission: c.get<string>('endpoints.submission', ''),
      submissions: c.get<string>(
        'endpoints.submissions',
        '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
      ),
      // 逐测试点结果：先用 listJudge.do 换出 judgeId，再 POST listAllJudgeRun.do。
      // `{timestamp}` 由 buildUrl 自动填，jqGrid 拿它做 cache buster。
      judgeList: c.get<string>(
        'endpoints.judgeList',
        '/xdoj-ssm/submission/listJudge.do?submissionId={id}&_search=false&nd={timestamp}&rows=5&page=1&sidx=&sord=asc',
      ),
      judgePage: c.get<string>(
        'endpoints.judgePage',
        '/xdoj-ssm/team/viewJudge.do?submissionId={id}',
      ),
      judgeRuns: c.get<string>('endpoints.judgeRuns', '/xdoj-ssm/submission/listAllJudgeRun.do'),
    },

    contestListTemplate: replaceOrDefaults(c.get('contestListTemplate'), DEFAULT_CONTEST_LIST_BODY),
    submissionListTemplate: replaceOrDefaults(c.get('submissionListTemplate'), DEFAULT_SUBMISSION_LIST_BODY),

    loginPayload: replaceOrDefaults(c.get('loginPayload'), DEFAULT_LOGIN_PAYLOAD),
    loginContentType: c.get<LoginContentType>('loginContentType', 'form'),
    tokenHeader: c.get<string>('tokenHeader', 'Authorization') || 'Authorization',
    tokenPrefix: c.get<string>('tokenPrefix', 'Bearer ') ?? 'Bearer ',

    useMockData: c.get<boolean>('useMockData', false),
    submitPayload: replaceOrDefaults(c.get('submitPayload'), DEFAULT_SUBMIT_PAYLOAD),
    submitEncoding: c.get<SubmitEncoding>('submitEncoding', 'multipart'),
    submitTranscode: c.get<string>('submitTranscode', 'none') === 'utf8' ? 'utf8' : 'none',
    submitFields: mergeByKey(c.get('submitFields'), DEFAULT_SUBMIT_FIELDS),
    submitFileField: (c.get<string>('submitFileField', 'sourceFile') ?? 'sourceFile').trim(),
    submitFileContentType: c.get<string>('submitFileContentType', 'text/x-c++src') ?? 'text/x-c++src',
    // 比赛数据里 languages[].id = 2 是「GNU C/C++」。
    submitLanguage: c.get<string>('submitLanguage', '2'),
    // 留空时会去提交页 HTML 里刮。
    classId: (c.get<string>('classId', '') ?? '').trim(),
    requestHeaders: asRecord(c.get('requestHeaders')),
    commonQueryParams: asRecord(c.get('commonQueryParams', DEFAULT_COMMON_QUERY)),
    extraCookies: asRecord(c.get('extraCookies', DEFAULT_EXTRA_COOKIES)),
    userAgent: c.get<string>('userAgent', DEFAULT_USER_AGENT) ?? DEFAULT_USER_AGENT,
    referers: mergeByKey(c.get('referers'), DEFAULT_REFERERS),
    sessionExpiredRedirect: c.get<string>('sessionExpiredRedirect', '/xdoj-ssm/') || '/xdoj-ssm/',
    prewarmSteps: asPrewarmSteps(c.get('prewarmSteps')),
    prewarmEnabled: c.get<boolean>('prewarmEnabled', true),
    retryOnServerError: c.get<boolean>('retryOnServerError', true),
    retryDelayMs: Math.max(0, c.get<number>('retryDelayMs', 400)),
    downloadDir: (c.get<string>('downloadDir', 'problems') ?? 'problems').trim(),
    pollIntervalMs: Math.max(500, c.get<number>('pollIntervalMs', 2000)),
    pollTimeoutMs: Math.max(5000, c.get<number>('pollTimeoutMs', 120_000)),
    // 题面接口要登录态，Office 在线预览抓不到文件，所以默认走本地下载。
    docxPreview: c.get<DocxPreviewMode>('docxPreview', 'download'),
    problemOpenColumn: c.get<OpenColumnMode>('problemOpenColumn', 'beside'),
    requestTimeoutMs: Math.max(1000, c.get<number>('requestTimeoutMs', 20_000)),
  };
}
