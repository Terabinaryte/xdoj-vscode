import * as vscode from 'vscode';
import { OjError } from './api/types';
import type { XdojConfig } from './config';
import { buildBaseHeaders, buildCookieHeader, resolveReferer } from './api/baseHeaders';
import { sendWithTransport } from './api/transport';
import { log, redactHeaders } from './logger';
import { findDeepString, interpolateTemplate } from './util/text';
import { resolveUrl } from './util/url';

/** 会话信息整体存进 VS Code 的加密凭据库，不落在 settings.json 里。 */
const SECRET_SESSION = 'xdoj.session';
/** 通过命令设置的密码。settings 里填了 `xdoj.password` 时以 settings 为准。 */
const SECRET_PASSWORD = 'xdoj.password';

export interface Session {
  /** 登录后拿到的 token；纯 Cookie 认证的 OJ 没有这个字段。 */
  token?: string;
  /** 从 Set-Cookie 收集到的 cookie，形如 `["PHPSESSID=abc; Path=/"]`。 */
  cookies: string[];
  account: string;
  /** 登录时站点的 origin；禁止把旧站点的凭据带到另一个主机。 */
  origin: string;
  obtainedAt: number;
}

/**
 * 登录会话管理。
 *
 * 不同 OJ 的登录接口差别很大，这里不写死任何一种，而是靠配置驱动：
 * 用 `xdoj.endpoints.login` 指路径、`xdoj.loginPayload` 描述字段名，
 * 然后把响应里的 token 和 Set-Cookie 都收下来，后续请求自动带上。
 */
export class SessionManager implements vscode.Disposable {
  private session: Session | undefined;
  /** 并发调用 login 时合并成一次请求，避免同时打出多个登录。 */
  private loginInFlight: Promise<Session> | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly getConfig: () => XdojConfig,
  ) {}

  get current(): Session | undefined {
    return this.session && this.sessionMatchesCurrentConfig(this.session) ? this.session : undefined;
  }

  get isLoggedIn(): boolean {
    return !!this.session && this.sessionMatchesCurrentConfig(this.session);
  }

  /** 当前会话是否仍属于现有站点与账户。 */
  private sessionMatchesCurrentConfig(session: Session): boolean {
    const config = this.getConfig();
    return session.origin === endpointOrigin(config.endpoint) && session.account === config.account.trim();
  }

  /** 展示用账户名：优先有效会话里的，其次配置里的。 */
  get displayAccount(): string {
    return (this.session && this.sessionMatchesCurrentConfig(this.session) ? this.session.account : '') ||
      this.getConfig().account || '';
  }

  /** 扩展启动时把上次的会话捞回来，省得每次开窗口都重新登录。 */
  async restore(): Promise<void> {
    try {
      const raw = await this.secrets.get(SECRET_SESSION);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<Session>;
      if (parsed && typeof parsed === 'object' && (parsed.token || (parsed.cookies?.length ?? 0) > 0)) {
        const origin = endpointOrigin(this.getConfig().endpoint);
        const account = this.getConfig().account.trim();
        if (
          !origin ||
          parsed.origin !== origin ||
          typeof parsed.account !== 'string' ||
          parsed.account !== account
        ) {
          log.warn('[auth] 保存的会话不属于当前站点或账户，已清除并要求重新登录');
          await this.secrets.delete(SECRET_SESSION);
        } else {
          this.session = {
            token: typeof parsed.token === 'string' ? parsed.token : undefined,
            cookies: Array.isArray(parsed.cookies) ? parsed.cookies.filter((c) => typeof c === 'string') : [],
            account: typeof parsed.account === 'string' ? parsed.account : '',
            origin,
            obtainedAt: typeof parsed.obtainedAt === 'number' ? parsed.obtainedAt : Date.now(),
          };
          log.info(`[auth] 已恢复上次的会话（账户 ${this.session.account || '未知'}）`);
        }
      }
    } catch (error) {
      log.warn('[auth] 恢复会话失败，将重新登录', error);
      await this.secrets.delete(SECRET_SESSION);
    }
    this.emitter.fire();
  }

  // ------------------------------------------------------------ 密码

  /** settings 里填了密码就用它，否则取加密凭据库里的。 */
  async readPassword(): Promise<string> {
    const fromSettings = this.getConfig().password;
    if (fromSettings) {
      return fromSettings;
    }
    return (await this.secrets.get(SECRET_PASSWORD)) ?? '';
  }

  async hasPassword(): Promise<boolean> {
    return (await this.readPassword()).length > 0;
  }

  async storePassword(password: string): Promise<void> {
    const trimmed = password ?? '';
    if (trimmed) {
      await this.secrets.store(SECRET_PASSWORD, trimmed);
    } else {
      await this.secrets.delete(SECRET_PASSWORD);
    }
    this.emitter.fire();
  }

  async clearPassword(): Promise<void> {
    await this.secrets.delete(SECRET_PASSWORD);
    this.emitter.fire();
  }

  /** 凭据是否齐全（地址 + 账户 + 密码），用于给用户更早的提示。 */
  async missingCredentials(): Promise<string[]> {
    const config = this.getConfig();
    const missing: string[] = [];
    if (!config.endpoint) {
      missing.push('OJ 地址（xdoj.endpoint）');
    }
    if (!config.account.trim()) {
      missing.push('账户（xdoj.account）');
    }
    if (!(await this.hasPassword())) {
      missing.push('密码（命令「XDOJ: 设置密码」或设置项 xdoj.password）');
    }
    return missing;
  }

  // ------------------------------------------------------------ 登录

  /**
   * 确保已有可用会话。force=true 时强制重新登录（token 过期走这条路）。
   */
  async login(force = false): Promise<Session> {
    if (!force && this.session && this.sessionMatchesCurrentConfig(this.session)) {
      return this.session;
    }
    if (this.session && !this.sessionMatchesCurrentConfig(this.session)) {
      await this.clearStaleSession();
    }
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<Session> {
    const config = this.getConfig();
    const missing = await this.missingCredentials();
    if (missing.length > 0) {
      throw new OjError(`登录信息不完整，还缺：${missing.join('、')}`);
    }

    const account = config.account.trim();
    const password = await this.readPassword();
    const url = resolveUrl(config.endpoint, config.endpoints.login);

    const vars: Record<string, string> = { account, password, username: account };
    const payload: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(config.loginPayload)) {
      payload[key] = interpolateTemplate(template, vars);
    }

    const headers: Record<string, string> = buildBaseHeaders(config, resolveReferer(config, 'login'));

    let body: string;
    if (config.loginContentType === 'form') {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        form.set(key, String(value));
      }
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    } else {
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    }

    // 只记录请求头（已脱敏），绝不记录 body —— 里面有明文密码。
    log.info(`[auth] POST ${url} 账户=${account}`, redactHeaders(headers));

    let response: Response;
    try {
      response = await sendWithTransport(config.httpTransport, {
        method: 'POST',
        url,
        headers,
        body,
        timeoutMs: config.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OjError(`登录请求超时（${config.requestTimeoutMs}ms）：${url}`, error);
      }
      throw new OjError(`登录请求失败：${url}`, error);
    }

    const cookies = readSetCookies(response);
    const text = await response.text();

    if (!response.ok) {
      // 4xx 说明服务端明确拒绝了这个凭据，旧会话一定是坏的，清掉；
      // 5xx 是服务端自己出问题，保留旧会话，避免一次抖动就把人踢下线。
      if (response.status >= 400 && response.status < 500) {
        await this.clearStaleSession();
      }
      throw new OjError(
        `登录失败：HTTP ${response.status} ${response.statusText}`,
        text.slice(0, 300),
        response.status,
      );
    }

    let parsed: unknown;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    const token = extractToken(parsed);

    // 关键：这里是 HTTP 200，但响应体里 `error: 1` 表示登录失败。
    // 而且 Tomcat 在失败时**照样下发 JSESSIONID**，所以绝不能靠「有没有 Cookie」来判断成败。
    const failure = extractFailureMessage(parsed);
    if (failure) {
      await this.clearStaleSession();
      throw new OjError(
        `登录被拒绝：${failure}（常见原因是账户或密码不正确）`,
        text.slice(0, 300),
      );
    }

    if (!token && cookies.length === 0) {
      await this.clearStaleSession();
      throw new OjError(
        '服务端既没有返回 token 也没有下发 Cookie，无法确认是否登录成功。' +
          '请检查 xdoj.endpoints.login / xdoj.loginPayload 是否和实际接口一致。',
        text.slice(0, 300),
      );
    }

    this.session = {
      token,
      cookies,
      account,
      origin: endpointOrigin(config.endpoint) ?? new URL(url).origin,
      obtainedAt: Date.now(),
    };
    await this.secrets.store(SECRET_SESSION, JSON.stringify(this.session));
    this.emitter.fire();
    log.info(
      `[auth] 登录成功：账户=${account}，方式=${token ? 'token' : 'cookie'}` +
        (cookies.length > 0 ? `，cookie×${cookies.length}` : ''),
    );
    return this.session;
  }

  /** endpoint / account 配置变化后清理不再匹配的会话。 */
  async invalidateIfConfigChanged(): Promise<void> {
    if (this.session && !this.sessionMatchesCurrentConfig(this.session)) {
      await this.clearStaleSession();
    }
  }

  async logout(): Promise<void> {
    this.session = undefined;
    await this.secrets.delete(SECRET_SESSION);
    this.emitter.fire();
    log.info('[auth] 已退出登录');
  }

  /** 服务端明确拒绝凭据时，把已经不可用的旧会话丢掉，免得状态栏继续谎报「已登录」。 */
  private async clearStaleSession(): Promise<void> {
    if (!this.session) {
      return;
    }
    log.warn('[auth] 登录被拒绝，清除已失效的会话');
    this.session = undefined;
    await this.secrets.delete(SECRET_SESSION);
    this.emitter.fire();
  }

  // ------------------------------------------------------------ 请求头

  /**
   * 生成业务请求要带的会话头（token + Cookie）。
   *
   * 注意：即使还没有会话，`xdoj.extraCookies`（例如 `preferred_lang=zh_CN`）
   * 也会照常发出——语言偏好不依赖登录。
   */
  async sessionHeaders(): Promise<Record<string, string>> {
    const config = this.getConfig();
    const headers: Record<string, string> = {};
    const session = this.session && this.sessionMatchesCurrentConfig(this.session) ? this.session : undefined;

    if (session?.token) {
      headers[config.tokenHeader] = `${config.tokenPrefix}${session.token}`;
    }

    const cookie = buildCookieHeader(config, session?.cookies ?? []);
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    return headers;
  }

  /**
   * 吸收业务响应里新下发的 cookie。
   * 不少 OJ 会在每次请求时刷新 session，不跟上就会掉登录。
   */
  absorbCookies(response: Response): void {
    if (!this.session || !this.sessionMatchesCurrentConfig(this.session)) {
      return;
    }
    const fresh = readSetCookies(response);
    if (fresh.length === 0) {
      return;
    }
    const merged = new Map<string, string>();
    for (const raw of [...this.session.cookies, ...fresh]) {
      const name = cookieName(raw);
      if (name) {
        merged.set(name, raw);
      }
    }
    this.session = { ...this.session, cookies: [...merged.values()] };
    void this.secrets.store(SECRET_SESSION, JSON.stringify(this.session));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// ------------------------------------------------------------------ 工具

function endpointOrigin(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Node 20+ 的 undici 提供 getSetCookie()，拿不到时退回到整条读并手工切分。 */
export function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };

  let list: string[] = [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      list = headers.getSetCookie() ?? [];
    } catch {
      list = [];
    }
  }

  if (list.length === 0) {
    const combined = headers.get('set-cookie');
    if (combined) {
      // 按「逗号 + 新 cookie 名=」切分，避免把 Expires 里的逗号当成分隔符。
      list = combined.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+\-.^`|~]+\s*=)/);
    }
  }

  return list.map((value) => value.trim()).filter(Boolean);
}

function cookieName(raw: string): string | undefined {
  const pair = raw.split(';')[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    return undefined;
  }
  return pair.slice(0, eq).trim() || undefined;
}

const TOKEN_KEY_PATTERN = /^(access_?token|auth_?token|token|jwt|ticket|session_?id|session_?key|sid)$/i;

function extractToken(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;

  // 显式失败标记优先，避免把错误响应里冒出来的字符串当成 token。
  if (record['success'] === false || record['ok'] === false) {
    return undefined;
  }

  return findDeepString(record, TOKEN_KEY_PATTERN, 3);
}

const FAILURE_PATTERNS = [
  /密码错误/,
  /账号或密码/,
  /用户名或密码/,
  /invalid\s+(username|password|credentials)/i,
  /incorrect\s+password/i,
  /wrong\s+password/i,
  /login\s+failed/i,
  /unauthor/i,
];

/**
 * 登录响应里表示「成功/失败」的状态字段名。
 *
 * `error` 一定要在里面：Spring SSM 那套后端很爱用 `{"error":0}` / `{"error":1}`，
 * 而 Tomcat 在登录失败的请求上也会照样下发 JSESSIONID。如果不认这个字段，
 * 就会把「密码错误」误判成登录成功。
 */
const STATUS_KEYS = [
  'error',
  'errCode',
  'errcode',
  'errno',
  'code',
  'status',
  'statusCode',
  'ret',
  'resultCode',
  'result_code',
];

const SUCCESS_CODES = new Set([0, 200]);

/** 从 `{error:1}` / `{code:1, message:"..."}` 这类响应里判断登录是否其实失败了。 */
function extractFailureMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;

  // 显式的成功标记优先，可以直接放行。
  if (record['success'] === true || record['ok'] === true) {
    return undefined;
  }

  const rawMessage =
    record['message'] ??
    record['msg'] ??
    record['errorMessage'] ??
    record['error_message'] ??
    record['errMsg'] ??
    record['error'];
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : undefined;

  if (message && FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return message;
  }
  if (record['success'] === false || record['ok'] === false) {
    return message || 'success=false';
  }

  for (const key of STATUS_KEYS) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];

    if (typeof value === 'number') {
      // 命中一个明确的状态码字段就到此为止：0 / 200 视为成功。
      return SUCCESS_CODES.has(value) ? undefined : message || `响应码 ${key}=${value}`;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^-?\d+$/.test(trimmed)) {
        const numeric = Number(trimmed);
        return SUCCESS_CODES.has(numeric) ? undefined : message || `响应码 ${key}=${trimmed}`;
      }
      // 非数字的状态字符串（例如 "ok" / "FAIL"）只在明显是错误时才判定失败，
      // 免得把 `{status:"ok"}` 这种成功响应错杀。
      if (trimmed && FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        return message || trimmed;
      }
      continue;
    }

    if (value === false) {
      return message || `${key}=false`;
    }
    if (value === true) {
      return undefined;
    }
  }

  return undefined;
}
