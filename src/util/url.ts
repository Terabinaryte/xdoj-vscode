/** URL 拼接与题面类型推断。 */

export function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * 把可能是相对路径的 `target` 拼到 `baseUrl` 上。
 * `target` 本身是完整 URL 时原样返回；baseUrl 为空时也原样返回。
 */
export function resolveUrl(baseUrl: string, target: string): string {
  const t = (target ?? '').trim();
  if (!t) {
    return '';
  }
  if (isAbsoluteUrl(t) || !baseUrl) {
    return t;
  }
  if (t.startsWith('//')) {
    const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(baseUrl)?.[1] ?? 'https:';
    return `${scheme}${t}`;
  }
  return `${baseUrl}${t.startsWith('/') ? '' : '/'}${t}`;
}

/** 用 `{key}` 占位符填充路径模板。值会被 encodeURIComponent。 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}

export function stripQuery(url: string): string {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

/** 从 URL / 文件名里取小写扩展名，不含点。 */
export function extensionOf(url: string): string {
  const withoutQuery = stripQuery(url);
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot < 0 || dot === lastSegment.length - 1) {
    return '';
  }
  return lastSegment.slice(dot + 1).toLowerCase();
}
