import { extensionOf } from '../util/url';

/** 题面文件在编辑器里怎么呈现。 */
export type StatementKind = 'pdf' | 'docx' | 'txt' | 'html' | 'binary' | 'none';

export interface DetectedFile {
  kind: StatementKind;
  /** 服务端给的文件名（Content-Disposition 优先）。 */
  filename?: string;
  /** 归一化后的小写扩展名，用于在界面上显示「.doc」这类信息。 */
  extension: string;
  /** 判断依据，写进日志方便排查。 */
  reason: string;
}

/**
 * 解析 Content-Disposition。
 *
 * 同时处理 `filename="a.pdf"` 和 RFC 5987 的 `filename*=UTF-8''%E9%A2%98.pdf`；
 * 中文文件名两个都见过。
 */
export function parseContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  // filename* 优先，它才带得动非 ASCII。
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const raw = star[1].trim().replace(/^["']|["']$/g, '');
    const encoded = raw.includes("''") ? raw.slice(raw.indexOf("''") + 2) : raw;
    const decoded = tryDecodeURIComponent(encoded);
    if (decoded) {
      return stripPath(decoded);
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header);
  if (plain) {
    const value = (plain[1] ?? plain[2] ?? '').trim();
    if (value) {
      return stripPath(tryDecodeURIComponent(value) ?? value);
    }
  }

  return undefined;
}

function tryDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** 有些服务端会把整个路径塞进 filename，只取最后一段。 */
function stripPath(value: string): string {
  return value.split(/[/\\]/).pop()?.trim() || value.trim();
}

/**
 * 判断题面文件是什么。
 *
 * 优先级：
 *   1. **内容魔数**（只在一票否决的情况下用）
 *   2. **Content-Disposition 里的文件名后缀** —— 主信号
 *   3. Content-Type
 *   4. 文本嗅探
 *
 * 为什么不是纯后缀判断：这个后端的登录响应就是
 * `Content-Disposition: attachment;filename=f.txt`，它习惯发通用名。
 * 要是题面下载也回 `f.txt`，「看后缀」就会把 PDF 当纯文本渲染。
 * 而 `%PDF-` 和 `PK\x03\x04` 这两个签名是确定性的，拿来兜底不会误伤：
 * 没有任何文本文件会以 `%PDF-` 开头。
 *
 * 反过来，扩展名能明确表达意图时（比如 `.doc`），就**不再**往下猜——
 * 用户要的是「拿去本地打开」，不是我们擅自换个渲染方式。
 */
export function detectStatementFile(options: {
  filename?: string;
  contentType?: string;
  bytes?: Uint8Array;
}): DetectedFile {
  const { filename, contentType, bytes } = options;
  const extension = filename ? extensionOf(filename) : '';
  const byExtension = extension ? kindFromExtension(extension) : 'none';

  // ---- 1. 魔数一票否决 -------------------------------------------------
  if (bytes && bytes.byteLength > 0) {
    if (looksLikePdf(bytes)) {
      // PDF 签名无歧义。即使服务端把名字写成 f.txt，也得按 PDF 渲染。
      return {
        kind: 'pdf',
        filename,
        extension: 'pdf',
        reason: byExtension === 'pdf' ? '文件名与内容都是 PDF' : `内容是 %PDF-（文件名后缀 .${extension || '无'} 不可信）`,
      };
    }
    if (looksLikeZip(bytes)) {
      // ZIP 容器：docx / xlsx / pptx / 真·zip 都长这样，只有后缀和 CT 能区分。
      if (byExtension === 'pdf') {
        // 后缀说 PDF、内容却是 ZIP —— 以后缀为准没意义，交给下面的兜底。
      } else if (byExtension !== 'none' && byExtension !== 'txt' && byExtension !== 'html') {
        return {
          kind: byExtension,
          filename,
          extension,
          reason: `文件名后缀 .${extension} + ZIP 容器`,
        };
      } else {
        return {
          kind: 'docx',
          filename,
          extension: extension || 'docx',
          reason: `内容像 ZIP 容器，按 docx 处理（原后缀 .${extension || '无'}）`,
        };
      }
    }
  }

  // ---- 2. 文件名后缀（主信号）------------------------------------------
  if (byExtension !== 'none') {
    return { kind: byExtension, filename, extension, reason: `文件名后缀 .${extension}` };
  }

  // ---- 3. Content-Type -------------------------------------------------
  const ct = (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (ct) {
    const byType = kindFromContentType(ct);
    if (byType !== 'none') {
      return {
        kind: byType,
        filename,
        extension: extensionForContentType(ct),
        reason: `Content-Type ${ct}`,
      };
    }
  }

  // ---- 4. 文本嗅探 -----------------------------------------------------
  if (bytes && looksLikeText(bytes)) {
    const text = decodeText(bytes, contentType);
    return looksLikeHtml(text)
      ? { kind: 'html', filename, extension: extension || 'html', reason: '内容是 HTML' }
      : { kind: 'txt', filename, extension: extension || 'txt', reason: '内容是纯文本' };
  }

  return {
    kind: 'binary',
    filename,
    extension: extension || 'bin',
    reason: extension ? `无法在编辑器里预览的 .${extension}` : '无法识别的二进制内容',
  };
}

function kindFromExtension(extension: string): StatementKind {
  switch (extension) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'docm':
    case 'dotx':
      return 'docx';
    case 'txt':
    case 'text':
    case 'in':
    case 'out':
    case 'log':
    case 'md':
    case 'markdown':
      return 'txt';
    case 'html':
    case 'htm':
      return 'html';
    case 'doc':
    case 'xls':
    case 'ppt':
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      // 明确认识，但编辑器渲染不了 —— 走「下载后用本地程序打开」。
      return 'binary';
    default:
      // 没见过的后缀，交回给上层继续判断（CT / 魔数）。
      return 'none';
  }
}

function kindFromContentType(ct: string): StatementKind {
  if (ct.includes('pdf')) {
    return 'pdf';
  }
  if (ct.includes('wordprocessingml') || ct.includes('officedocument.wordprocessingml')) {
    return 'docx';
  }
  if (ct.includes('msword') || ct.includes('ms-excel') || ct.includes('ms-powerpoint')) {
    return 'binary';
  }
  if (ct.startsWith('text/html') || ct.startsWith('application/xhtml')) {
    return 'html';
  }
  // text/plain 之外别急着当文本：application/octet-stream 要落到魔数判断。
  if (ct.startsWith('text/')) {
    return 'txt';
  }
  return 'none';
}

function extensionForContentType(ct: string): string {
  if (ct.includes('pdf')) {
    return 'pdf';
  }
  if (ct.includes('wordprocessingml')) {
    return 'docx';
  }
  if (ct.includes('msword')) {
    return 'doc';
  }
  if (ct.startsWith('text/html')) {
    return 'html';
  }
  return 'txt';
}

const CHARSET_PATTERN = /charset\s*=\s*"?([\w-]+)"?/i;

/**
 * 按响应声明的 charset 解码文本。
 * 国内 OJ 的 txt 题面不少是 GBK，用 UTF-8 硬解会全是乱码。
 */
export function decodeText(bytes: Uint8Array, contentType?: string): string {
  const declared = contentType ? CHARSET_PATTERN.exec(contentType)?.[1] : undefined;
  const candidates = [declared, 'utf-8'].filter((v): v is string => !!v);

  for (const charset of candidates) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // 运行时认不出这个 charset，换下一个。
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function looksLikePdf(buffer: Uint8Array): boolean {
  // 有些站点会在 PDF 前面塞 BOM / 空白，所以扫前 1KB 找魔数。
  const head = buffer.subarray(0, Math.min(buffer.byteLength, 1024));
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  outer: for (let i = 0; i + marker.length <= head.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (head[i + j] !== marker[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function looksLikeZip(buffer: Uint8Array): boolean {
  return (
    buffer.length > 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  );
}

/**
 * 内容看起来是不是一个 HTML 页面。
 *
 * 用于兜底：登录态失效时服务端会 302 到登录页，如果探测没拦住，
 * 题面下载就会把登录页当成附件。宁可报错也不能把 HTML 存成 .pdf。
 */
export function looksLikeHtmlDocument(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 2048));
  // 跳过 BOM 和前导空白
  let start = 0;
  while (start < head.length && (head[start] === 0xef || head[start] === 0xbb || head[start] === 0xbf ||
         head[start] === 0x20 || head[start] === 0x09 || head[start] === 0x0a || head[start] === 0x0d)) {
    start++;
  }
  return /^<(?:!doctype\s+html|html|head|body)\b/i.test(
    new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(start, start + 64)),
  );
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(text);
}

/** 粗略判断是不是文本：不含 NUL，且控制字符比例很低。 */
function looksLikeText(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 2048));
  if (sample.length === 0) {
    return false;
  }
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    // 允许 \t \n \r，其余 C0 控制字符都算可疑。
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      control++;
    }
  }
  return control / sample.length < 0.02;
}

/** 清理成安全的文件名，去掉路径分隔符和 Windows 禁用字符。 */
export function sanitizeFileName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}
