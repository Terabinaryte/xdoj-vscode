import {
  OjError,
  type Contest,
  type OjClient,
  type ProblemContent,
  type ProblemDetail,
  type ProblemSummary,
  type SubmitInput,
  type SubmitResult,
  type StatementMeta,
  type Submission,
  type TestCaseRun,
} from './types';
import {
  extractSubmissionId,
  normalizeContestList,
  normalizeProblem,
  normalizeProblemDetail,
  normalizeSubmission,
  normalizeSubmissionList,
  normalizeTestCaseRuns,
} from './normalize';
import {
  decodeText,
  detectStatementFile,
  looksLikeHtmlDocument,
  parseContentDisposition,
} from './statement';
import { parseFormFields, parseHiddenInputs } from '../util/html';
import { sendWithTransport } from './transport';

/** 最近一次请求实际发出的头，供诊断导出 curl 用。 */
let lastSentHeaders: Record<string, string> = {};
import { readSetCookies, type SessionManager } from '../auth';
import { buildBaseHeaders, resolveReferer, type EndpointKey } from './baseHeaders';
import type { XdojConfig } from '../config';
import { log, redactHeaders } from '../logger';
import { fillTemplate, resolveUrl } from '../util/url';
import { interpolateTemplate, pickString, toArray, toRecord } from '../util/text';

/** 走真实 HTTP 的 OJ 客户端。所有路径都来自配置，方便适配不同 OJ。 */
export class HttpOjClient implements OjClient {
  readonly label: string;
  /** 已经预热过的比赛。换比赛或换会话都要重做。 */
  private prewarmedContestId: string | undefined;

  constructor(
    private readonly config: XdojConfig,
    private readonly session: SessionManager,
  ) {
    this.label = config.endpoint || '(未配置 OJ 地址)';
  }

  /**
   * 展开接口模板。
   *
   * 除了调用方给的变量，`{account}` / `{userId}` 和 `{timestamp}` 总是自动可用：
   * XDOJ 的列表接口两样都要（`userId=...&nd=<毫秒时间戳>`）。
   */
  private buildUrl(template: string, vars: Record<string, string> = {}): string {
    const merged: Record<string, string> = {
      account: this.config.account,
      userId: this.config.account,
      timestamp: String(Date.now()),
      ...vars,
    };
    const url = resolveUrl(this.config.endpoint, fillTemplate(template, merged));
    return appendQuery(url, this.config.commonQueryParams);
  }

  /** 手写在 requestHeaders 里的头优先级最高，可以覆盖会话自动生成的头。 */
  private async headers(
    referer?: string,
    extra?: Record<string, string>,
    navigation = false,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = buildBaseHeaders(this.config, referer, { navigation });
    if (extra) {
      Object.assign(headers, extra);
    }
    const present = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
    const auth = await this.session.sessionHeaders();
    for (const [key, value] of Object.entries(auth)) {
      if (!present.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    return headers;
  }

  private async requestRaw(
    method: string,
    url: string,
    init: {
      body?: string;
      formData?: FormData;
      contentType?: string;
      accept?: string;
      referer?: string;
      removeHeaders?: string[];
      extraHeaders?: Record<string, string>;
      /** 按「浏览器导航」的样子发：HTML 的 Accept，且不带 X-Requested-With。 */
      navigation?: boolean;
    } = {},
    allowRelogin = true,
    redirectDepth = 0,
    retriesLeft = -1,
  ): Promise<Response> {
    if (!url) {
      throw new OjError('接口地址为空，请检查 xdoj.endpoint 与 xdoj.endpoints 配置');
    }
    if (!/^https?:/i.test(url)) {
      // 最常见的原因就是没填站点根地址：这时 URL 只剩相对路径。
      if (!this.config.endpoint) {
        throw new OjError(
          '还没配置 OJ 站点根地址（xdoj.endpoint），所有接口都发不出去。' +
            '在设置里填上你的 OJ 根地址（例如 http://your-oj.example/）即可。',
        );
      }
      throw new OjError(`不支持的协议（只支持 http/https）：${url}`);
    }

    const extra: Record<string, string> = {};
    // multipart 的 Content-Type 必须让 fetch 自己生成（要带 boundary），不能手写。
    if (init.contentType && !init.formData) {
      extra['Content-Type'] = init.contentType;
    }
    const headers = await this.headers(
      init.referer,
      Object.keys(extra).length > 0 ? extra : undefined,
      init.navigation === true,
    );
    if (init.accept) {
      headers['Accept'] = init.accept;
    }

    // 诊断用的二分开关：摘掉某些头 / 覆盖某些头，看清到底是哪一项导致服务端报错。
    if (init.removeHeaders) {
      const drop = new Set(init.removeHeaders.map((name) => name.toLowerCase()));
      for (const key of Object.keys(headers)) {
        if (drop.has(key.toLowerCase())) {
          delete headers[key];
        }
      }
    }
    if (init.extraHeaders) {
      Object.assign(headers, init.extraHeaders);
    }
    lastSentHeaders = { ...headers };

    // 这个 OJ 会间歇性抽风（同一个请求这次 500、下次 200）。
    // 只重试 GET/HEAD —— POST 重试有重复提交的风险。
    const effectiveRetries =
      retriesLeft >= 0 ? retriesLeft : this.config.retryOnServerError && isIdempotent(method) ? 2 : 0;

    log.info(`[http] ${method} ${url}`, redactHeaders(headers));

    let response: Response;
    try {
      response = await sendWithTransport(this.config.httpTransport, {
        method,
        url,
        headers,
        body: init.formData ?? init.body,
        timeoutMs: this.config.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OjError(`请求超时（${this.config.requestTimeoutMs}ms）：${url}`, error);
      }
      throw new OjError(`请求失败：${url}`, error);
    }

    // 有些 OJ 每次请求都会刷新 session cookie，不跟上就会掉登录。
    this.session.absorbCookies(response);

    // 登录态失效：服务端 302 回登录页。
    if (this.isSessionExpiredRedirect(response, url)) {
      if (!allowRelogin) {
        throw new OjError(
          `登录态已失效（服务端跳转到 ${response.headers.get('location') ?? '登录页'}），重新登录后仍然如此`,
          undefined,
          302,
        );
      }
      log.info(`[http] ${response.status} → 登录页，重新登录后重试：${url}`);
      try {
        await this.session.login(true);
      } catch (error) {
        throw new OjError(
          `登录态已失效，且自动重新登录失败：${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      return await this.requestRaw(method, url, init, false, redirectDepth);
    }

    // token 过期或被踢下线（有些接口用 401/403）。
    if ((response.status === 401 || response.status === 403) && allowRelogin) {
      log.info(`[http] ${response.status}，尝试重新登录后重试：${url}`);
      try {
        await this.session.login(true);
        return await this.requestRaw(method, url, init, false, redirectDepth);
      } catch (error) {
        log.warn('[http] 重新登录失败，按原始响应继续', error);
      }
    }

    // 服务端 5xx：隔一小会儿重试。GET 是幂等的，重试安全。
    if (response.status >= 500 && effectiveRetries > 0) {
      const retry = effectiveRetries - 1;
      log.warn(`[http] ${response.status}，${this.config.retryDelayMs}ms 后重试（还剩 ${retry} 次）：${url}`);
      await response.arrayBuffer().catch(() => undefined);
      if (this.config.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));
      }
      return this.requestRaw(method, url, init, allowRelogin, redirectDepth, retry);
    }

    // 其它跳转自己跟：301/302/303 按浏览器习惯降级成 GET，307/308 保留方法和 body。
    return this.followRedirect(response, method, url, init, redirectDepth);
  }

  private async followRedirect(
    response: Response,
    method: string,
    url: string,
    init: { body?: string; formData?: FormData; contentType?: string; accept?: string; referer?: string },
    depth: number,
  ): Promise<Response> {
    if (![301, 302, 303, 307, 308].includes(response.status) || depth >= 5) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      return response;
    }

    const keepBody = response.status === 307 || response.status === 308;
    log.info(`[http] 跟随 ${response.status} → ${next}`);
    const nextInit = keepBody
      ? init
      : { contentType: undefined, referer: init.referer, accept: init.accept };
    return this.requestRaw(keepBody ? method : 'GET', next, nextInit, true, depth + 1);
  }

  /**
   * 判断这个响应是不是「登录态失效」的跳转。
   *
   * XDOJ 失效时不做 401/403，而是直接 302 到站点根 —— 如果用 redirect: 'follow'，
   * 会静默跟到登录页拿到 HTTP 200，然后被当成正常数据（题面下载甚至会
   * 把登录页写成 .pdf），所以必须自己识别。
   */
  private isSessionExpiredRedirect(response: Response, requestUrl: string): boolean {
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return false;
    }
    const location = response.headers.get('location');
    if (!location) {
      return false;
    }
    let resolved: URL;
    try {
      resolved = new URL(location, requestUrl);
    } catch {
      return false;
    }

    // 跳到登录页本身也算失效。
    if (/login\.jsp$/i.test(stripJsessonid(resolved.pathname))) {
      return true;
    }

    const target = resolveUrl(this.config.endpoint, this.config.sessionExpiredRedirect);
    try {
      const targetPath = normalizePath(new URL(target).pathname);
      return normalizePath(stripJsessonid(resolved.pathname)) === targetPath;
    } catch {
      return false;
    }
  }

  private async requestJson<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
    referer?: string,
  ): Promise<T> {
    const response = await this.requestRaw(method, url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : 'application/json; charset=UTF-8',
      referer,
    });
    return this.parseJson<T>(response, url);
  }

  /** jqGrid 那套接口要求 POST + form-urlencoded。 */
  private async requestFormJson<T = unknown>(url: string, form: string, referer?: string): Promise<T> {
    const response = await this.requestRaw('POST', url, {
      body: form,
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      referer,
    });
    return this.parseJson<T>(response, url);
  }

  /** 取某个接口的 Referer。 */
  private referer(key: EndpointKey, vars: Record<string, string> = {}): string | undefined {
    return resolveReferer(this.config, key, vars);
  }

  /**
   * 诊断用：模拟浏览器的完整登录流程 —— **先打开登录页，再 POST 登录**。
   *
   * 扩展平时是直接 POST login.do 的。如果服务端依赖登录页在 session 里
   * 放的状态，两条路径产生的会话就会不一样。这里返回新会话的 Cookie 头，
   * 供诊断用它去重试失败的接口。
   */
  async tryBrowserLikeLogin(): Promise<{ cookie: string; steps: string[] } | undefined> {
    const loginTemplate = this.config.endpoints.login.trim();
    if (!loginTemplate) {
      return undefined;
    }
    const steps: string[] = [];
    const cookies = new Map<string, string>();

    try {
      return await this.runBrowserLikeLogin(steps, cookies);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push(`实验失败：${message}`);
      return { cookie: '', steps };
    }
  }

  private async runBrowserLikeLogin(
    steps: string[],
    cookies: Map<string, string>,
  ): Promise<{ cookie: string; steps: string[] }> {
    const loginTemplate = this.config.endpoints.login.trim();
    if (!loginTemplate) {
      return { cookie: '', steps };
    }

    const collect = (response: Response): void => {
      for (const raw of readSetCookies(response)) {
        const pair = (raw.split(';')[0] ?? '').trim();
        const eq = pair.indexOf('=');
        if (eq > 0) {
          cookies.set(pair.slice(0, eq).trim(), pair);
        }
      }
    };

    // 1) 打开登录页，建立会话
    const pageTemplate = this.config.endpoints.loginPage.trim();
    if (pageTemplate) {
      const pageUrl = this.buildUrl(pageTemplate);
      const page = await this.requestRaw('GET', pageUrl, {
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: this.referer('loginPage'),
        removeHeaders: ['Cookie'],
      });
      collect(page);
      const pageHtml = await page.text();
      steps.push(`GET ${pageUrl} → ${page.status}，拿到 ${cookies.size} 个 Cookie`);

      // 登录页的字段清单：能直接看出我们漏发了什么（例如 userType）。
      const fields = parseFormFields(pageHtml);
      const described = fields
        .map((f) => {
          if (f.kind === 'select') {
            const opts = Object.entries(f.options ?? {})
              .map(([v, label]) => `${v}=${label}`)
              .join('|');
            return `${f.name}<select:${opts}>`;
          }
          const value = f.value !== undefined && f.value !== '' ? `=${f.value}` : '';
          return `${f.name}<${f.kind}>${value}`;
        })
        .join(', ');
      steps.push(`      登录页表单字段：${described || '(没解析到具名控件)'}`);
    }

    // 2) 带着这个会话去登录
    const url = this.buildUrl(loginTemplate);
    const form = new URLSearchParams();
    const vars: Record<string, string> = {
      account: this.config.account,
      username: this.config.account,
      password: (await this.session.readPassword()) ?? '',
    };
    for (const [key, template] of Object.entries(this.config.loginPayload)) {
      form.set(key, String(interpolateTemplate(template, vars) ?? ''));
    }
    const cookieHeader = [...cookies.values()].join('; ');

    const login = await this.requestRaw('POST', url, {
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: this.referer('login'),
      removeHeaders: ['Cookie'],
      extraHeaders: cookieHeader ? { Cookie: cookieHeader } : undefined,
    });
    collect(login);
    const text = await login.text();
    steps.push(`POST ${url} → ${login.status}，响应 ${text.slice(0, 100)}`);

    const finalCookie = [...cookies.values()].join('; ');
    return finalCookie ? { cookie: finalCookie, steps } : { cookie: '', steps };
  }

  /** 诊断用：打一个 URL 并压成一行结果，绝不抛异常。 */
  async probe(
    method: string,
    url: string,
    options: {
      body?: string;
      contentType?: string;
      referer?: string;
      accept?: string;
      /** 从最终请求里摘掉这些头，用于二分定位。 */
      removeHeaders?: string[];
      /** 覆盖 / 追加请求头（最后应用，优先级最高）。 */
      extraHeaders?: Record<string, string>;
      /** 失败时不把响应体写进日志（二分实验会用很多次，避免刷屏）。 */
      quiet?: boolean;
    } = {},
  ): Promise<{
    status: number;
    ok: boolean;
    summary: string;
    bytes: number;
    sentHeaders: Record<string, string>;
  }> {
    try {
      const response = await this.requestRaw(method, url, {
        body: options.body,
        contentType: options.contentType,
        accept: options.accept ?? '*/*',
        referer: options.referer,
        removeHeaders: options.removeHeaders,
        extraHeaders: options.extraHeaders,
      });
      const text = await response.text();
      const sentHeaders = lastSentHeaders;
      if (response.ok) {
        return {
          status: response.status,
          ok: true,
          summary: `${text.length} 字节`,
          bytes: text.length,
          sentHeaders,
        };
      }
      const summary = summarizeErrorBody(text, response.headers.get('content-type') ?? '');
      if (!options.quiet) {
        log.error(`[诊断] ${method} ${url} → ${response.status}\n  响应体: ${text.slice(0, 2000)}`);
      }
      return { status: response.status, ok: false, summary, bytes: text.length, sentHeaders };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[诊断] ${method} ${url} → 请求异常：${message}`);
      return { status: 0, ok: false, summary: message, bytes: 0, sentHeaders: lastSentHeaders };
    }
  }

  /**
   * 诊断用：列出各接口实际会请求的 URL。
   *
   * 比赛题目会额外给一条 `rows=10` 的对照 —— 抓包里浏览器用的就是 10，
   * 而我们默认发 100，如果服务端对 rows 敏感这里就能直接看出来。
   */
  diagnosticTargets(
    contestId?: string,
    problemId?: string,
  ): Array<{
    label: string;
    method: string;
    url: string;
    body?: string;
    contentType?: string;
    referer?: string;
    accept?: string;
  }> {
    const targets: Array<{
      label: string;
      method: string;
      url: string;
      body?: string;
      contentType?: string;
      referer?: string;
      accept?: string;
    }> = [];

    const form = 'application/x-www-form-urlencoded; charset=UTF-8';

    if (this.config.endpoints.contests.trim()) {
      targets.push({
        label: '比赛列表',
        method: 'POST',
        url: this.buildUrl(this.config.endpoints.contests),
        body: buildFormBody(this.config.contestListTemplate),
        contentType: form,
        referer: this.referer('contests'),
      });
    }

    if (contestId && this.config.endpoints.contestProblems.trim()) {
      const referer = this.referer('contestProblems', { contestId });
      const url = this.buildUrl(this.config.endpoints.contestProblems, { contestId });
      targets.push({ label: '比赛题目（当前配置）', method: 'GET', url, referer });

      const alt = url.replace(/([?&]rows=)\d+/, '$110');
      if (alt !== url) {
        targets.push({ label: '比赛题目（rows=10 对照）', method: 'GET', url: alt, referer });
      }
    }

    if (problemId && this.config.endpoints.statement.trim()) {
      targets.push({
        label: '题面下载',
        method: 'GET',
        url: this.buildUrl(this.config.endpoints.statement, { id: problemId }),
        referer: this.referer('statement', { id: problemId }),
        accept: '*/*',
      });
    }

    if (contestId && this.config.endpoints.submissions.trim()) {
      targets.push({
        label: '提交记录',
        method: 'POST',
        url: this.buildUrl(this.config.endpoints.submissions, { contestId }),
        body: buildFormBody(this.config.submissionListTemplate),
        contentType: form,
        referer: this.referer('submissions', { contestId }),
      });
    }

    return targets;
  }

  private async parseJson<T>(response: Response, url: string): Promise<T> {
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      const summary = summarizeErrorBody(text, contentType);
      // 完整响应体写进日志 —— 服务端 500 时这里往往带着 Java 异常栈，是定位问题的关键。
      log.error(
        `HTTP ${response.status} ${response.statusText} ${url}\n` +
          `  content-type: ${contentType || '(无)'}\n` +
          `  响应体: ${text.slice(0, 4000) || '(空)'}`,
      );
      throw new OjError(
        `HTTP ${response.status}${summary ? `：${summary}` : ''}`,
        text.slice(0, 2000),
        response.status,
      );
    }
    if (!text.trim()) {
      return undefined as T;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const hint = looksLikeHtmlDocument(new TextEncoder().encode(text))
        ? '服务端返回的是 HTML 页面，登录态可能已失效（请重新登录）'
        : '响应不是合法 JSON';
      throw new OjError(`${hint}：${url}`, text.slice(0, 500), response.status);
    }

    // HTTP 200 但响应体里报错的情况（`{"code":1,"info":"..."}`）也当失败处理，
    // 否则调用方会拿着一个「看起来像数据」的错误对象继续跑。
    const apiError = describeApiError(parsed);
    if (apiError) {
      throw new OjError(`${apiError}：${url}`, parsed, response.status);
    }
    return parsed as T;
  }

  // ------------------------------------------------------------ 比赛与题目

  async listContests(): Promise<Contest[]> {
    const template = this.config.endpoints.contests.trim();
    if (!template) {
      return [];
    }
    const url = this.buildUrl(template);
    const form = buildFormBody(this.config.contestListTemplate);
    const raw = await this.requestFormJson(url, form, this.referer('contests'));
    const contests = normalizeContestList(raw);
    log.info(`比赛列表：${contests.length} 个（${url}）`);
    return contests;
  }

  /**
   * 展开 URL 模板，额外支持 `{endpoint}`。
   *
   * `{endpoint}` 必须**原样替换**（它本身就是 URL），不能走 URL 编码 ——
   * 否则会变成 `%7Bendpoint%7D`。
   */
  private resolveTemplateUrl(template: string, vars: Record<string, string>): string {
    const withEndpoint = template.replace(/\{endpoint\}/g, this.config.endpoint);
    return resolveUrl(this.config.endpoint, fillTemplate(withEndpoint, vars));
  }

  /** 换会话后要重新预热。 */
  resetPrewarm(): void {
    this.prewarmedContestId = undefined;
  }

  /**
   * 按配置的步骤序列建立服务端会话状态。
   *
   * XDOJ 的「当前比赛」是靠 `POST team/selectContest.do`（body `contestId=<比赛ID>`）
   * 写进 session 的，而 `contest/problems.do` 会去取它且没判 null ——
   * 没建好就直接 `ClassCastException`。浏览器是页面 → 选中比赛 → 页面 → AJAX
   * 这么走的，扩展得复刻。
   *
   * **每场比赛都要做一次**（选 demo-contest 和选 demo-contest-2 是不同的状态），
   * 换会话（重新登录）后也要重做。
   */
  async warmUpContest(contestId: string): Promise<void> {
    if (!this.config.prewarmEnabled || this.prewarmedContestId === contestId) {
      return;
    }
    const steps = this.config.prewarmSteps;
    if (steps.length === 0) {
      return;
    }
    this.prewarmedContestId = contestId;

    const vars: Record<string, string> = {
      contestId,
      account: this.config.account,
      userId: this.config.account,
      timestamp: String(Date.now()),
      id: contestId,
    };

    // Referer 默认串成链（下一步指向上一步的 URL）；步骤里写了就以它为准。
    let referer = `${this.config.endpoint}/xdoj-ssm/team/dashboard.do`;

    for (const step of steps) {
      const url = this.resolveTemplateUrl(step.url, vars);
      const stepReferer = step.referer ? this.resolveTemplateUrl(step.referer, vars) : referer;
      const method = (step.method || 'GET').toUpperCase();
      const body =
        step.body === undefined ? undefined : String(interpolateTemplate(step.body, vars));

      try {
        const response = await this.requestRaw(method, url, {
          body,
          contentType: body === undefined ? undefined : (step.contentType ?? 'application/x-www-form-urlencoded; charset=UTF-8'),
          referer: stepReferer,
          // GET 按页面导航的样子发；POST 是 AJAX，带 X-Requested-With。
          navigation: method === 'GET',
        });
        await response.arrayBuffer();
        log.info(`[prewarm] ${method} ${url} → ${response.status}`);
      } catch (error) {
        log.warn(`[prewarm] ${method} ${url} 失败，继续后面的步骤`, error);
      }
      referer = url;
    }
  }

  async getContestProblems(contestId: string): Promise<ProblemSummary[]> {
    await this.warmUpContest(contestId);

    const template = this.config.endpoints.contestProblems.trim();
    if (!template) {
      throw new OjError(
        '还没有配置「比赛下的题目」接口（xdoj.endpoints.contestProblems），' +
          '展开比赛时不知道该请求哪里。',
      );
    }
    const url = this.buildUrl(template, { contestId });
    const raw = await this.requestJson('GET', url, undefined, this.referer('contestProblems', { contestId }));
    const problems = toArray(raw)
      .map((item, index) => normalizeProblem(item, String(index + 1), contestId))
      .filter((p): p is ProblemSummary => !!p);
    log.info(`比赛 ${contestId} 下共 ${problems.length} 题（${url}）`);
    return problems;
  }

  async listProblems(): Promise<ProblemSummary[]> {
    const url = this.buildUrl(this.config.endpoints.problems);
    const raw = await this.requestJson('GET', url, undefined, this.referer('problems'));
    const problems = toArray(raw)
      .map((item, index) => normalizeProblem(item, String(index + 1)))
      .filter((p): p is ProblemSummary => !!p);
    log.info(`题目列表：${problems.length} 条（${url}）`);
    return problems;
  }

  async getProblem(id: string): Promise<ProblemDetail> {
    const url = this.buildUrl(this.config.endpoints.problem, { id });
    const raw = await this.requestJson('GET', url, undefined, this.referer('problem', { id }));
    return normalizeProblemDetail(toRecord(raw) ?? raw, id);
  }

  /**
   * 拉取题面附件。
   *
   * XDOJ 的 `downloadTextFile.do` 按题目返回 PDF / DOCX / TXT，文件名只给在
   * `Content-Disposition` 里，类型判断见 `detectStatementFile`。
   * 这个接口需要登录态，所以附件由扩展下载后交给 webview 渲染（而不是让浏览器去抓）。
   */
  async loadContent(detail: ProblemDetail): Promise<ProblemContent> {
    if (detail.inlineContent) {
      const bytes = new TextEncoder().encode(detail.inlineContent.body);
      const meta: StatementMeta = { byteLength: bytes.byteLength };
      return detail.inlineContent.kind === 'html'
        ? { ...meta, kind: 'html', html: detail.inlineContent.body, data: bytes }
        : { ...meta, kind: 'txt', text: detail.inlineContent.body, data: bytes };
    }

    const sourceUrl = detail.contentUrl
      ? resolveUrl(this.config.endpoint, detail.contentUrl)
      : undefined;
    if (!sourceUrl) {
      return { kind: 'none', reason: '该题没有配置题面附件地址' };
    }

    const response = await this.requestRaw('GET', sourceUrl, {
      accept: '*/*',
      referer: this.referer('statement', { id: detail.id }),
    });

    if (!response.ok) {
      return {
        kind: 'none',
        reason: `HTTP ${response.status} ${response.statusText}`,
        sourceUrl,
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? undefined;
    const filename = parseContentDisposition(response.headers.get('content-disposition'));
    const detected = detectStatementFile({ filename, contentType, bytes });

    // 兜底：按后缀应当拿到 PDF/DOCX，实际却是 HTML —— 基本可以断定是登录页。
    // 这里必须拦住，否则会把登录页存成 .pdf 并且在界面上表现得像成功了。
    if (
      (detected.kind === 'pdf' || detected.kind === 'docx' || detected.kind === 'binary') &&
      looksLikeHtmlDocument(bytes)
    ) {
      const reason =
        '服务端返回的是 HTML 页面而不是题面文件，通常是登录态已失效。' +
        '请用命令「XDOJ: 登录」重新登录后重试。';
      log.warn(`题面 ${detail.id} 拿到 HTML 而非 ${detected.kind}：${sourceUrl}`);
      return { kind: 'none', reason, sourceUrl };
    }

    const meta: StatementMeta = {
      filename: detected.filename,
      extension: detected.extension,
      sourceUrl,
      byteLength: bytes.byteLength,
    };
    log.info(
      `题面 ${detail.id}：${detected.kind}（${detected.reason}），` +
        `${bytes.byteLength} 字节，文件名=${detected.filename ?? '(无)'}`,
    );

    switch (detected.kind) {
      case 'pdf':
        return { ...meta, kind: 'pdf', data: bytes };
      case 'docx':
        // publicUrl 只在文件能被公网匿名访问时对 Office 在线预览有用；
        // 这个接口需要登录态，所以默认走「下载后本地打开」。
        return { ...meta, kind: 'docx', data: bytes, publicUrl: sourceUrl };
      case 'html':
        return { ...meta, kind: 'html', html: decodeText(bytes, contentType), data: bytes };
      case 'txt':
        return { ...meta, kind: 'txt', text: decodeText(bytes, contentType), data: bytes };
      case 'binary':
      default:
        return { ...meta, kind: 'binary', data: bytes };
    }
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const url = this.buildUrl(this.config.endpoints.submit, {
      problemId: input.problemId,
      contestId: input.contestId ?? '',
    });
    const referer = this.referer('submit', {
      problemId: input.problemId,
      contestId: input.contestId ?? '',
    });

    this.warnIfSourceDropped();
    const raw =
      this.config.submitEncoding === 'multipart'
        ? await this.submitMultipart(url, referer, input)
        : await this.submitPayload(url, referer, input);
    // XDOJ 只回 `{"code":0,"info":"success"}`，没有提交 ID。
    const submissionId = extractSubmissionId(raw);
    if (submissionId) {
      log.info(`提交成功：submissionId=${submissionId}`);
    } else {
      log.info('提交成功，但响应里没有提交 ID —— 稍后靠提交记录列表认领。');
    }
    return submissionId ? { submissionId, raw } : { raw };
  }

  /**
   * `xdoj.submitFileField` 留空 = 不发文件部分，源码只能靠某个表单字段的 `{code}` 带上去。
   * 两者都没配好就会**提交一份空代码**，服务端只会回个成功，很坑，这里提前吼一声。
   */
  private warnIfSourceDropped(): void {
    if (this.config.submitEncoding !== 'multipart' || this.config.submitFileField) {
      return;
    }
    const carriesCode = Object.values(this.config.submitFields).some((value) =>
      String(value).includes('{code}'),
    );
    if (!carriesCode) {
      log.warn(
        'xdoj.submitFileField 是空的，而 xdoj.submitFields 里也没有任何字段用到 {code} —— ' +
          '这份提交不会带任何源码。要么把 submitFileField 恢复成 sourceFile（XDOJ 的默认值），' +
          '要么把某个字段（例如 sourceCode）的值改成 {code}。',
      );
    }
  }

  private async submitMultipart(
    url: string,
    referer: string | undefined,
    input: SubmitInput,
  ): Promise<unknown> {
    const vars = this.submitVars(input);
    const form = new FormData();

    for (const [name, template] of Object.entries(this.config.submitFields)) {
      form.append(name, String(interpolateTemplate(template, vars) ?? ''));
    }

    const fileField = this.config.submitFileField;
    if (fileField) {
      // 有原始字节就用原始字节 —— 文件可能是 GB2312，字符串重编码会改成 UTF-8。
      const payload = input.codeBytes
        ? toBlobPart(input.codeBytes)
        : toBlobPart(new TextEncoder().encode(input.code));
      form.append(
        fileField,
        new Blob([payload], { type: this.config.submitFileContentType }),
        input.filename,
      );
    }

    const response = await this.requestRaw('POST', url, { formData: form, referer });
    return this.parseJson(response, url);
  }

  private async submitPayload(
    url: string,
    referer: string | undefined,
    input: SubmitInput,
  ): Promise<unknown> {
    const vars = this.submitVars(input);
    const payload: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(this.config.submitPayload)) {
      payload[key] = interpolateTemplate(template, vars);
    }

    if (this.config.submitEncoding === 'form') {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        form.set(key, String(value));
      }
      const response = await this.requestRaw('POST', url, {
        body: form.toString(),
        contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        referer,
      });
      return this.parseJson(response, url);
    }

    return this.requestJson('POST', url, payload, referer);
  }

  private submitVars(input: SubmitInput): Record<string, string> {
    return {
      problemId: input.problemId,
      contestId: input.contestId ?? '',
      classId: input.classId ?? '',
      account: this.config.account,
      userId: this.config.account,
      language: input.language,
      languageId: input.language,
      code: input.code,
      filename: input.filename,
      timestamp: String(Date.now()),
    };
  }

  /**
   * 拉提交页并刮出隐藏字段。
   *
   * XDOJ 的 `classId` 是服务端渲染进 `<input type="hidden">` 的，
   * 没有独立接口，只能这么拿。
   */
  async loadSubmitPage(problemId: string, contestId?: string): Promise<Record<string, string>> {
    const template = this.config.endpoints.submitPage.trim();
    if (!template) {
      return {};
    }
    const vars = { problemId, contestId: contestId ?? '' };
    const url = this.buildUrl(template, vars);
    try {
      const response = await this.requestRaw('GET', url, {
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: this.referer('submitPage', vars),
      });
      if (!response.ok) {
        log.warn(`提交页返回 HTTP ${response.status}，跳过硬编码字段的提取`);
        return {};
      }
      const fields = parseHiddenInputs(await response.text());
      log.info(`提交页隐藏字段：${Object.keys(fields).join(', ') || '(无)'}`);
      return fields;
    } catch (error) {
      log.warn('拉取提交页失败，改用配置里的值', error);
      return {};
    }
  }

  async getSubmission(id: string, contestId?: string): Promise<Submission | undefined> {
    const template = this.config.endpoints.submission.trim();

    if (template) {
      const url = this.buildUrl(template, { id });
      const raw = await this.requestJson('GET', url, undefined, this.referer('submission', { id }));
      return normalizeSubmission(toRecord(raw) ?? raw);
    }

    // 没有单条接口时退回扫描列表 —— XDOJ 的 results.do 一行就带了全部信息。
    if (!contestId) {
      return undefined;
    }
    const list = await this.listSubmissions(contestId);
    return list.find((item) => item.id === id);
  }

  /**
   * 逐测试点结果。
   *
   * 流程是两步：先 GET judge 页面刮出 `judgeId`，再 POST `listAllJudgeRun.do`。
   * `judgeId` 和提交 ID **不是同一个号**（同一次提交的 `submissionId` 和 `judgeId` 是两个不同的号），
   * 所以提交记录里带了就直接用，没带才去页面里刮。
   */
  async loadTestCaseRuns(input: { submissionId: string; judgeId?: string }): Promise<TestCaseRun[]> {
    const runsTemplate = this.config.endpoints.judgeRuns.trim();
    if (!runsTemplate) {
      throw new OjError('没有配置 xdoj.endpoints.judgeRuns，取不到测试点结果');
    }

    const pageTemplate = this.config.endpoints.judgePage.trim();
    const pageUrl = pageTemplate
      ? this.resolveTemplateUrl(pageTemplate, { id: input.submissionId })
      : undefined;

    const judgeId = await this.resolveJudgeId(input.submissionId, input.judgeId);
    if (!judgeId) {
      throw new OjError(
        `拿不到 judgeId（提交 ${input.submissionId}）。` +
          '正常流程是 GET submission/listJudge.do 换出来；' +
          '请检查 xdoj.endpoints.judgeList（或兜底的 judgePage）。',
      );
    }

    const url = this.buildUrl(runsTemplate, { judgeId, id: input.submissionId });
    const body = new URLSearchParams({ judgeId }).toString();
    const raw = await this.requestFormJson<unknown>(url, body, pageUrl);
    return normalizeTestCaseRuns(raw);
  }

  /**
   * 拿到 `judgeId`。
   *
   * 三条路，从可靠到将就：
   * 1. 提交记录里已经带了（`judgeId` / 后端拼错的 `jugeId`）
   * 2. `submission/listJudge.do?submissionId=...` —— 返回的评测记录里 `id` 就是 judgeId
   * 3. 从 judge 页面 HTML 里刮（老接口不可用时的兜底）
   *
   * 注意 judgeId 和提交 ID **不是同一个号**（同一次提交的 `submissionId` 和 `judgeId` 是两个不同的号）。
   */
  private async resolveJudgeId(submissionId: string, known?: string): Promise<string | undefined> {
    const fromRecord = known?.trim();
    if (fromRecord) {
      return fromRecord;
    }

    const listTemplate = this.config.endpoints.judgeList.trim();
    if (listTemplate) {
      const url = this.buildUrl(listTemplate, { id: submissionId });
      try {
        const response = await this.requestRaw('GET', url, {
          accept: 'application/json, text/javascript, */*; q=0.01',
          referer: this.referer('judgeList', { id: submissionId }),
        });
        const rows = toArray(await this.parseJson<unknown>(response, url));
        const record = rows.find((row) => row && typeof row === 'object');
        const judgeId =
          record && typeof record === 'object'
            ? pickString(record as Record<string, unknown>, ['id', 'judgeId', 'judge_id', 'jugeId'])
            : undefined;
        if (judgeId) {
          log.info(`listJudge.do 换来 judgeId=${judgeId}（提交 ${submissionId}）`);
          return judgeId;
        }
        log.warn(`listJudge.do 没有返回评测记录（提交 ${submissionId}），改用页面兜底`);
      } catch (error) {
        log.warn(`listJudge.do 失败（提交 ${submissionId}）：${String(error)}，改用页面兜底`);
      }
    }

    const pageTemplate = this.config.endpoints.judgePage.trim();
    if (pageTemplate) {
      return this.scrapeJudgeId(this.resolveTemplateUrl(pageTemplate, { id: submissionId }));
    }
    return undefined;
  }

  /** 从 judge 页面里刮 `judgeId`（页面里是 `judgeId: demo-judge` 或 `judgeId=demo-judge`）。 */
  private async scrapeJudgeId(pageUrl: string): Promise<string | undefined> {
    try {
      // 这是「打开页面」，按导航处理（HTML 的 Accept）；Referer 不强求。
      const response = await this.requestRaw('GET', pageUrl, {
        accept: 'text/html,application/xhtml+xml,*/*',
        navigation: true,
      });
      if (!response.ok) {
        log.warn(`judge 页面返回 HTTP ${response.status}，刮不到 judgeId`);
        return undefined;
      }
      const html = await response.text();
      // 真实站点的 judgeId 是数字；这里同时接受字母标识（测试里的 fixture 用它们），
      // 但要排除 `judgeId: null` / `undefined` 这类占位，否则会拿着 "null" 去请求。
      const match = /judgeId\s*[:=]\s*['"]?([A-Za-z0-9_.-]+)/i.exec(html);
      const candidate = match?.[1];
      if (candidate && !/^(null|undefined|nan|none|true|false)$/i.test(candidate)) {
        log.info(`从 judge 页面刮到 judgeId=${candidate}`);
        return candidate;
      }
      log.warn('judge 页面里没找到可用的 judgeId');
      return undefined;
    } catch (error) {
      log.warn(`拉 judge 页面失败：${String(error)}`);
      return undefined;
    }
  }

  async listSubmissions(contestId?: string): Promise<Submission[]> {
    const template = this.config.endpoints.submissions.trim();
    if (!template) {
      return [];
    }
    const url = this.buildUrl(template, contestId ? { contestId } : {});
    const form = buildFormBody(this.config.submissionListTemplate);
    const raw = await this.requestFormJson(url, form, this.referer('submissions', { contestId: contestId ?? '' }));
    const list = normalizeSubmissionList(raw);
    log.info(`提交记录：${list.length} 条（${url}）`);
    return list;
  }
}

/**
 * 把字节转成可以塞进 `Blob` 的片段。
 *
 * 必须复制一份：`Buffer` 常常是 8KB 池里的一个视图，`byteOffset`/`byteLength`
 * 只是切片，直接丢给 `Blob` 在部分实现里会把整个池子都发出去。
 */
function toBlobPart(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * 把配置里的模板对象编码成 form-urlencoded 请求体。
 * `{timestamp}` 会替换成当前毫秒时间戳（jqGrid 用它做 cache buster）。
 */
function buildFormBody(template: Record<string, string>): string {
  const form = new URLSearchParams();
  const now = Date.now();
  for (const [key, value] of Object.entries(template)) {
    form.set(key, String(value).replace(/\{timestamp\}/g, String(now)));
  }
  return form.toString();
}

/**
 * 把公共 query 参数并到 URL 上。
 * 模板里已经写了的同名参数不覆盖，方便个别接口单独指定。
 */
function appendQuery(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (!url || keys.length === 0) {
    return url;
  }
  try {
    const parsed = new URL(url);
    for (const key of keys) {
      if (!parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, params[key]);
      }
    }
    return parsed.toString();
  } catch {
    // URL 畸形时不折腾，原样发出去让服务端报错更直观。
    return url;
  }
}

/**
 * 识别「HTTP 200 但响应体报错」。
 * XDOJ 用 `{"code":0,"info":"success"}` 表示成功，非 0 就是失败。
 */
function describeApiError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  if (record['success'] === false) {
    return readApiMessage(record) ?? 'success=false';
  }

  for (const key of ['code', 'error', 'errcode', 'errCode']) {
    const value = record[key];
    if (typeof value === 'number' && value !== 0 && value !== 200) {
      return readApiMessage(record) ?? `${key}=${value}`;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      const numeric = Number(value);
      if (numeric !== 0 && numeric !== 200) {
        return readApiMessage(record) ?? `${key}=${value}`;
      }
    }
  }
  return undefined;
}

function readApiMessage(record: Record<string, unknown>): string | undefined {
  for (const key of ['info', 'message', 'msg', 'errorMessage', 'error_message', 'error']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stripJsessonid(path: string): string {
  return path.replace(/;jsessionid=[^/?#]*/gi, '');
}

/** 去掉末尾斜杠再比，`/xdoj-ssm` 和 `/xdoj-ssm/` 视为同一个位置。 */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/**
 * 把错误响应体压成一行可读的摘要，便于直接显示在侧栏。
 *
 * Java 后端的 500 往往返回一整页 HTML 异常栈，原样显示会淹掉界面，
 * 但里面那句异常信息恰好是最有价值的。
 */
function summarizeErrorBody(text: string, contentType: string): string {
  const body = text.trim();
  if (!body) {
    return '';
  }

  // JSON 错误：优先拿 message 类字段。
  if (contentType.includes('json') || body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const message = readApiMessage(parsed);
      if (message) {
        return message;
      }
      const code = parsed['code'] ?? parsed['error'] ?? parsed['errcode'];
      if (code !== undefined) {
        return `code=${String(code)}`;
      }
    } catch {
      /* 不是合法 JSON，继续往下 */
    }
  }

  // Tomcat 的错误页有固定结构，先把「消息」和「根本原因」抠出来，
  // 比事后从一堆标签里猜要准得多。
  if (/<title>\s*HTTP状态\s*\d+/i.test(body) || /Apache Tomcat/i.test(body)) {
    const message = /<p>\s*<b>\s*消息\s*<\/b>\s*([\s\S]*?)<\/p>/i.exec(body)?.[1];
    const rootCause = /<b>\s*根本原因。?\s*<\/b>\s*<\/p>\s*<pre>\s*([\s\S]*?)<\s*\/pre>/i.exec(body)?.[1];
    const parts = [
      message ? markupToText(message) : undefined,
      rootCause ? markupToText(rootCause) : undefined,
    ].filter((v): v is string => !!v && v.length > 0);
    // 消息里往往已经含了根因，重复就只留一条。
    const unique = [...new Set(parts)];
    if (unique.length > 0) {
      const joined = unique.join(' / ');
      return joined.length > 220 ? `${joined.slice(0, 220)}…` : joined;
    }
  }

  // 其它 HTML 错误页：剥掉标签，优先挑出异常信息那一行。
  // 注意 `<` 后面必须跟字母 / `/` / `!` / `?` 才算标签 —— 否则
  // `rows must be <= 50</p>` 里的 `<=` 会被当成标签开头，把内容一起吃掉。
  const plain = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?=[a-zA-Z/!?])[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) {
    return '';
  }
  const exception = /[\w.$]*(?:Exception|Error)[^。;]{0,160}/.exec(plain);
  const chosen = exception ? exception[0] : plain;
  return chosen.length > 200 ? `${chosen.slice(0, 200)}…` : chosen;
}

/** 把一小段带标签的 HTML 压成单行文本。 */
function markupToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 幂等方法才允许自动重试，避免重复提交。 */
function isIdempotent(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD';
}
