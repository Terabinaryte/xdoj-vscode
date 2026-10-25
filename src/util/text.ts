/** 纯文本工具：HTML 转义、归一化、字节格式化。 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 从对象里按候选键顺序取第一个有值的字符串字段。 */
export function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(source[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true' || value === 1 || value === '1') {
      return true;
    }
    if (value === 'false' || value === 0 || value === '0') {
      return false;
    }
  }
  return undefined;
}

export function pickRecord(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * 各种 OJ 返回结构五花八门，这里逐层剥开常见的信封字段，
 * 尽量找到真正承载数据的数组。
 */
const ENVELOPE_KEYS = ['data', 'result', 'payload', 'body', 'response'];

const COLLECTION_KEYS = [
  'problems', 'problemList', 'items', 'list', 'records', 'rows',
  'submissions', 'submissionList', 'data', 'results', 'content',
];

export function toArray(raw: unknown): Record<string, unknown>[] {
  const found = findArray(raw, 0);
  return found ?? [];
}

function findArray(value: unknown, depth: number): Record<string, unknown>[] | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // 先试语义明确的集合字段，再退回通用信封字段。
  for (const key of COLLECTION_KEYS) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return findArray(nested, depth + 1);
    }
  }
  for (const key of ENVELOPE_KEYS) {
    if (key in record) {
      const found = findArray(record[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** 从响应里取出单个对象（可能是 `{data: {...}}` 这类信封）。 */
export function toRecord(raw: unknown): Record<string, unknown> | undefined {
  return findRecord(raw, 0);
}

function findRecord(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth > 4 || !value || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? findRecord(value[0], depth + 1) : undefined;
  }
  const record = value as Record<string, unknown>;
  const dataKeys = [...COLLECTION_KEYS, ...ENVELOPE_KEYS];
  for (const key of dataKeys) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const deeper = findRecord(nested, depth + 1);
      if (deeper) {
        return deeper;
      }
    }
  }
  return record;
}

/**
 * 时间戳归一化。
 *
 * 见过三种形态：
 * - `1700000000`（秒）/ `1700000000000`（毫秒）
 * - `"2026-01-06 19:35:57"` —— XDOJ 的 submitTime 就是这种，按**本地时间**解析
 * - ISO 字符串
 */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = parseDateString(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const n = asNumber(value);
  if (n === undefined || n <= 0) {
    return undefined;
  }
  return n < 1e11 ? n * 1000 : n;
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/** 末尾带 `Z` 或 `+08:00` 这类时区标记。 */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})\s*$/i;

function parseDateString(value: string): number | undefined {
  const text = value.trim();
  if (!text) {
    return undefined;
  }

  // 带时区的按标准 ISO 解析 —— 千万别落进下面那条本地时间分支，
  // 否则 `2026-01-06T09:00:00Z` 会被当成本地 09:00，整体平移一个时区。
  if (HAS_TIMEZONE.test(text)) {
    const iso = Date.parse(text);
    return Number.isFinite(iso) ? iso : undefined;
  }

  // 不带时区的 `YYYY-MM-DD HH:mm[:ss]` 按**本地时间**解析。国内 OJ 返回的
  // 都是北京时间，交给 `new Date("...")` 会因格式非 ISO 而产生实现相关的行为。
  const match = LOCAL_DATETIME.exec(text);
  if (match) {
    const [, y, mo, d, h, mi, sec] = match;
    const ms = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec ?? '0'),
    ).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  const iso = Date.parse(text);
  return Number.isFinite(iso) ? iso : undefined;
}

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `${sec} 秒前`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} 分钟前`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return `${hour} 小时前`;
  }
  return `${Math.floor(hour / 24)} 天前`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 把可能带 markdown/HTML 的题面标题压成单行纯文本，便于放进 TreeItem。 */
export function toPlainTitle(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 用变量填充模板字符串。
 * 整个值就是 `{key}` 时按原样替换（保持数字/布尔类型），
 * 嵌在别的文本里时做字符串拼接。
 */
export function interpolateTemplate(template: string, vars: Record<string, string>): unknown {
  const exact = /^\{(\w+)\}$/.exec(template);
  if (exact) {
    const value = vars[exact[1]];
    return value === undefined ? template : value;
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * 在嵌套对象里按正则找第一个匹配键的字符串值。
 * 用于从各家 OJ 结构各异的登录响应里挖出 token。
 */
export function findDeepString(
  value: unknown,
  keyPattern: RegExp,
  maxDepth = 3,
): string | undefined {
  return search(value, keyPattern, maxDepth, 0);
}

function search(value: unknown, keyPattern: RegExp, maxDepth: number, depth: number): string | undefined {
  if (depth > maxDepth || !value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    if (keyPattern.test(key)) {
      const found = asString(raw);
      if (found) {
        return found;
      }
    }
  }
  for (const raw of Object.values(record)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const found = search(raw, keyPattern, maxDepth, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
