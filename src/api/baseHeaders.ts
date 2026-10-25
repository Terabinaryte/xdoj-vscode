import type { XdojConfig } from '../config';
import { fillTemplate } from '../util/url';

/**
 * 可以单独指定 Referer 的接口。
 * 键名和 `xdoj.endpoints` 里的字段一一对应。
 */
export type EndpointKey =
  | 'login'
  | 'loginPage'
  | 'contests'
  | 'contestProblems'
  | 'problems'
  | 'problem'
  | 'statement'
  | 'submitPage'
  | 'submit'
  | 'submission'
  | 'submissions'
  | 'judgeList'
  | 'judgePage'
  | 'judgeRuns';

/**
 * 解开某个接口的 Referer 模板。
 *
 * 模板里可以用 `{endpoint}`（不编码，因为它本身就是 URL）以及
 * `{account}` / `{userId}` / `{timestamp}` / `{contestId}` / `{id}` 等占位符。
 * 返回 undefined 表示这个接口不发 Referer。
 */
export function resolveReferer(
  config: XdojConfig,
  key: EndpointKey,
  vars: Record<string, string> = {},
): string | undefined {
  const template = (config.referers[key] ?? '').trim();
  if (!template) {
    return undefined;
  }

  // {endpoint} 先原样替换掉，剩下的占位符才做 URL 编码。
  const withEndpoint = template.replace(/\{endpoint\}/g, config.endpoint);
  const merged: Record<string, string> = {
    account: config.account,
    userId: config.account,
    timestamp: String(Date.now()),
    ...vars,
  };
  return fillTemplate(withEndpoint, merged);
}

/**
 * 构造所有请求共用的基础请求头。
 *
 * 优先级（低 → 高）：
 *   1. 内置默认（Accept / X-Requested-With / User-Agent）
 *   2. 本次请求的 Referer —— 由接口决定，见 `resolveReferer`
 *   3. `xdoj.requestHeaders` —— 用户手写的头永远能盖掉上面两者
 *   4. 调用方传入的 per-request 头（Content-Type 之类）
 *
 * 登录和业务请求都走这里，免得两边的头慢慢长歪。
 */
export function buildBaseHeaders(
  config: XdojConfig,
  referer?: string,
  options: { navigation?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = options.navigation
    ? {
        // 真实浏览器导航请求的样子。地址栏打开页面不会带 X-Requested-With，
        // 服务端可能靠它区分「页面」和「AJAX」两条处理路径。
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      }
    : {
        // 和抓包看到的 jQuery 默认值保持一致。
        Accept: 'application/json, text/javascript, */*; q=0.01',
        // XDOJ 的 .do 接口是 AJAX 端点，带上这个头表明是 XHR 请求。
        'X-Requested-With': 'XMLHttpRequest',
        // 抓包里的浏览器请求带了这个头，服务端的 LocaleResolver 可能会用到。
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };

  const userAgent = config.userAgent.trim();
  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  if (referer) {
    headers['Referer'] = referer;
  }

  // 手写头最后铺上去，优先级最高。
  Object.assign(headers, config.requestHeaders);
  return headers;
}

/**
 * 汇总要发送的 Cookie。
 *
 * `xdoj.extraCookies` 放在最前面，登录拿到的会话 Cookie 在后 ——
 * 同名时以后者为准（服务端下发的比配置里的静态值更权威）。
 */
export function buildCookieHeader(
  config: XdojConfig,
  sessionCookies: readonly string[],
): string {
  const merged = new Map<string, string>();

  // ⚠️ 顺序有讲究：**会话 Cookie 必须排在前面**。
  //
  // 抓包里浏览器发的是 `JSESSIONID=...; preferred_lang=zh_CN`，JSESSIONID 在前。
  // 有些 Java 实现会偷懒用 `request.getCookies()[0]` 取 session id ——
  // 顺序一颠倒它们拿到的就是 `preferred_lang`，然后拿着一个错的会话去做强转，
  // 直接抛 ClassCastException（实测 XDOJ 的 contest/problems.do 就是这样 500 的）。
  for (const raw of sessionCookies) {
    const pair = (raw.split(';')[0] ?? '').trim();
    const eq = pair.indexOf('=');
    if (eq > 0) {
      merged.set(pair.slice(0, eq).trim(), pair);
    }
  }

  // 额外 Cookie 放后面，且不覆盖服务端下发的同名 Cookie。
  for (const [name, value] of Object.entries(config.extraCookies)) {
    const key = name.trim();
    if (key && !merged.has(key)) {
      merged.set(key, `${key}=${value}`);
    }
  }

  return [...merged.values()].join('; ');
}
