/**
 * 提交前取源码字节。
 *
 * 为什么不能只用 `document.getText()`：
 *
 * `getText()` 返回的是**已经解码过**的字符串——VS Code 按它识别出的编码
 * （UTF-8 / GBK / GB18030 …）把磁盘字节解成 JS 字符串。之后如果把这个字符串
 * 交给 `Blob` / `FormData`，运行时只会按 UTF-8 再编回去，于是：
 *
 *   - 原文件是 GB2312 且里面有中文 → 上传的字节和磁盘上的**不是同一份**；
 *   - 如果 VS Code 把 GB2312 当成了 UTF-8（`files.autoGuessEncoding` 默认关），
 *     解码结果里全是 U+FFFD，再编成 UTF-8 就把中文彻底写坏，
 *     连字符串字面量都可能编译不过。
 *
 * 浏览器上传 `<input type="file">` 时发的是**原始字节**，扩展要对齐这个行为，
 * 所以这里直接读磁盘（`document.save()` 之后磁盘就是编辑器里的内容）。
 */

import * as vscode from 'vscode';

export interface SourceSnapshot {
  /** 上传用的字节。正常情况下就是磁盘上的那份。 */
  bytes: Uint8Array;
  /** 编辑器里的文本（按 VS Code 识别的编码解码出来的）。 */
  text: string;
  /** VS Code 识别的编码 id，例如 `utf8` / `gbk` / `utf8bom`。 */
  encoding: string;
  /** 字节是否来自磁盘；false 表示退回了内存里的文本编码成 UTF-8。 */
  fromDisk: boolean;
  /** 磁盘字节不是合法 UTF-8 —— 说明这是个非 UTF-8 文件。 */
  nonUtf8: boolean;
  /** 文本里有替换字符（U+FFFD），即 VS Code 的解码是有损的。 */
  lossy: boolean;
}

/** 判断一段字节是不是合法的 UTF-8。 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    // fatal 会在遇到非法序列时抛错，比事后找 U+FFFD 更可靠
    // （合法的 U+FFFD 也可能本来就在文件里）。
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 文本里有没有解码失败留下的替换字符。 */
export function hasReplacementChar(text: string): boolean {
  return text.includes('\uFFFD');
}

/**
 * 取一份可以安全上传的源码快照。
 *
 * 只有一种情况用内存文本：文件还没落盘（未命名文档、保存失败）。
 * 那时拿不到原始字节，只能按 UTF-8 编内存里的文本，至少内容和编辑器一致。
 */
export async function readSourceSnapshot(document: vscode.TextDocument): Promise<SourceSnapshot> {
  const text = document.getText();
  const encoding = (document as { encoding?: string }).encoding ?? 'utf8';
  const memory: SourceSnapshot = {
    bytes: new TextEncoder().encode(text),
    text,
    encoding,
    fromDisk: false,
    nonUtf8: false,
    lossy: hasReplacementChar(text),
  };

  // 未命名文档没有磁盘文件。
  if (document.isUntitled || document.uri?.scheme !== 'file') {
    return memory;
  }

  // 仍然是脏的 —— save() 失败或没被调用，磁盘上的内容已经过时，
  // 这时候读磁盘会提交旧代码，比编码不对更糟。
  if (document.isDirty) {
    return memory;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    if (bytes.byteLength === 0 && text.length > 0) {
      // 空文件但内存里有内容：读到的不是我们想要的，别传个空文件上去。
      return memory;
    }
    return {
      bytes,
      text,
      encoding,
      fromDisk: true,
      nonUtf8: !isValidUtf8(bytes),
      lossy: hasReplacementChar(text),
    };
  } catch {
    return memory;
  }
}
