import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * HTTP 传输层。
 *
 * 为什么不用 `fetch`（Node 内置的 undici）：
 *
 * undici 会**硬加**两个删不掉的头 —— `accept-encoding: gzip, deflate` 和
 * `sec-fetch-mode: cors`，而且默认复用 TCP 连接。curl 这两个都不发、每次新建连接，
 * 浏览器发的又是完整的一套 `sec-fetch-*`。
 *
 * XDOJ 这种写得比较糙的后端对这些差异很敏感：同一个会话、同一个 URL，
 * curl 和浏览器一直正常，走 fetch 就一直 500（而且服务端抛的还是
 * `ClassCastException` 这种完全不指向根因的异常）。所以这里用 `node:http`
 * 逐字节自己控制请求，行为对齐 curl。
 */
export type HttpTransport = 'node' | 'fetch';

export interface TransportInit {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | FormData;
  timeoutMs: number;
}

/** 这些状态码按规范不能带响应体。 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * 用 `node:http` / `node:https` 发一个请求，返回标准的 `Response`。
 *
 * 返回真正的 `Response` 是为了让调用方（parseJson / readSetCookies /
 * arrayBuffer）完全不用改。
 */
export async function nodeHttpRequest(init: TransportInit): Promise<Response> {
  const url = new URL(init.url);
  const isHttps = url.protocol === 'https:';
  const send = isHttps ? httpsRequest : httpRequest;

  const headers: Record<string, string> = { ...init.headers };
  let payload: Buffer | undefined;

  if (init.body instanceof FormData) {
    // Node 内置的 FormData 没有公开的序列化接口，但可以让 Response 帮我们编码：
    // 拿到的 body 是完整的 multipart，Content-Type 里带着 boundary。
    const encoded = new Response(init.body);
    const contentType = encoded.headers.get('content-type');
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    payload = Buffer.from(await encoded.arrayBuffer());
  } else if (typeof init.body === 'string') {
    payload = Buffer.from(init.body, 'utf8');
  }
  if (payload) {
    headers['Content-Length'] = String(payload.byteLength);
  }

  return await new Promise<Response>((resolve, reject) => {
    const request: ClientRequest = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers,
        // 每次新建连接、用完即关，不复用 —— 和 curl 一致。
        // 复用连接在有些后端上会串味（上一次请求的会话状态残留）。
        agent: false,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(toResponse(response, chunks));
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      },
    );

    request.setTimeout(init.timeoutMs, () => {
      request.destroy(new Error(`请求超时（${init.timeoutMs}ms）`));
    });
    request.on('error', reject);

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function toResponse(response: IncomingMessage, chunks: Buffer[]): Response {
  const status = response.statusCode ?? 0;

  // 用 rawHeaders 而不是 headers：后者会把多个 Set-Cookie 合并成一条，
  // 而我们要按条取出每个 cookie 的 Path/HttpOnly。
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    headers.append(raw[i], raw[i + 1]);
  }

  const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
  return new Response(body, {
    status,
    // statusMessage 可能是非 ASCII，Response 会因此抛错，这里只在安全时带上。
    statusText: isAscii(response.statusMessage ?? '') ? (response.statusMessage ?? '') : '',
    headers,
  });
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * 按配置选传输层发请求。
 *
 * 登录（SessionManager）和业务请求都走这里，避免两条路径行为不一致 ——
 * 之前登录是直接调全局 fetch 的，绕过了传输层和 5xx 重试。
 */
export async function sendWithTransport(
  transport: HttpTransport,
  init: TransportInit,
): Promise<Response> {
  if (transport === 'node') {
    return nodeHttpRequest(init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await fetch(init.url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      // 跳转自己处理：登录态失效时服务端会 302 到站点根，跟着走会拿到登录页并伪装成 200。
      redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
  }
}
