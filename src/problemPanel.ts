import * as vscode from 'vscode';
import type { ProblemContent, ProblemDetail } from './api/types';
import type { XdojConfig } from './config';
import { log } from './logger';
import { escapeHtml } from './util/text';
import { resolveUrl } from './util/url';

export interface ProblemPanelDeps {
  /** 把题面附件另存到临时目录并用系统默认程序打开（docx 在线预览不可用时的兜底）。 */
  openExternally(detail: ProblemDetail, content: ProblemContent): Promise<void>;
  /** 重新拉取题面内容。 */
  reload(detail: ProblemDetail): Promise<void>;
  /** 面板里的「提交」按钮：提交当前 cpp 到这道题。 */
  submit(problemId: string): Promise<void>;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  detail: ProblemDetail;
  content: ProblemContent;
  config: XdojConfig;
}

/**
 * 管理所有题面标签页。同一道题只会有一个标签页，再次打开会复用并聚焦。
 */
export class ProblemPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
  /** 当前聚焦的题号变化时触发，用于推断「提交到哪道题」。 */
  readonly onDidChangeActiveProblem = this.changeEmitter.event;
  private activeProblemId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: ProblemPanelDeps,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.syncActiveFromEditors()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.syncActiveFromEditors()),
    );
  }

  get activeId(): string | undefined {
    return this.activeProblemId;
  }

  /** 当前是否有该题的标签页。 */
  has(id: string): boolean {
    return this.panels.has(id);
  }

  async show(detail: ProblemDetail, content: ProblemContent, config: XdojConfig): Promise<void> {
    const existing = this.panels.get(detail.id);
    if (existing) {
      existing.detail = detail;
      existing.content = content;
      existing.config = config;
      existing.panel.title = panelTitle(detail);
      existing.panel.webview.html = this.buildHtml(existing);
      existing.panel.reveal(existing.panel.viewColumn, true);
      this.setActive(detail.id);
      return;
    }

    const column = this.resolveColumn(config);

    const panel = vscode.window.createWebviewPanel(
      'xdoj.problem',
      panelTitle(detail),
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );

    const entry: PanelEntry = { panel, detail, content, config };
    this.panels.set(detail.id, entry);

    // 先挂消息监听再赋值 html：webview 里的脚本会立刻发 ready，不能漏掉那条消息。
    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.handleMessage(entry, message),
      undefined,
      this.disposables,
    );
    panel.webview.html = this.buildHtml(entry);

    panel.onDidChangeViewState(
      () => {
        if (panel.active) {
          this.setActive(detail.id);
        } else {
          this.syncActiveFromEditors();
        }
      },
      undefined,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        this.panels.delete(detail.id);
        if (this.activeProblemId === detail.id) {
          this.syncActiveFromEditors();
        }
      },
      undefined,
      this.disposables,
    );

    // 这里千万不能再传 column：如果它是 ViewColumn.Beside，reveal 会**再开一栏**，
    // 结果每开一道题就多出两栏。这里按 panel 自己的实际栏位来。
    panel.reveal(panel.viewColumn, false);
    this.setActive(detail.id);
  }

  /**
   * 新题面开在哪一栏。
   *
   * `ViewColumn.Beside` 的语义是「在**旁边新开一栏**」——每调一次就多一栏，
   * 开 5 道题就变成 5 栏（这正是「越开越窄」的原因）。
   * 所以已经有题面标签页时，直接复用那一栏。
   */
  private resolveColumn(config: XdojConfig): vscode.ViewColumn {
    if (config.problemOpenColumn !== 'beside') {
      return vscode.ViewColumn.Active;
    }
    return this.occupiedColumn() ?? vscode.ViewColumn.Beside;
  }

  /** 已经开着的题面标签页占着哪一栏（没有就用 undefined）。 */
  occupiedColumn(): vscode.ViewColumn | undefined {
    for (const entry of this.panels.values()) {
      const column = entry.panel.viewColumn;
      if (typeof column === 'number' && column > 0) {
        return column;
      }
    }
    return undefined;
  }

  /** 用新拉到的内容刷新已打开的标签页（例如重新加载题面后）。 */
  update(detail: ProblemDetail, content: ProblemContent): void {
    const entry = this.panels.get(detail.id);
    if (!entry) {
      return;
    }
    entry.detail = detail;
    entry.content = content;
    entry.panel.title = panelTitle(detail);
    entry.panel.webview.html = this.buildHtml(entry);
  }

  private async handleMessage(entry: PanelEntry, message: WebviewMessage): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.postContent(entry);
        break;
      case 'openExternal':
        if (message.url) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case 'copyUrl':
        if (message.url) {
          await vscode.env.clipboard.writeText(message.url);
          void vscode.window.showInformationMessage('已复制题面地址');
        }
        break;
      case 'reload':
        await this.deps.reload(entry.detail);
        break;
      case 'openDocxExternally':
        await this.deps.openExternally(entry.detail, entry.content);
        break;
      case 'openLocalFile':
        if (message.path) {
          await vscode.env.openExternal(vscode.Uri.file(message.path));
        }
        break;
      case 'revealInFolder':
        if (message.path) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.path));
        }
        break;
      case 'submit':
        await this.deps.submit(entry.detail.id);
        break;
      case 'log':
        log.info(`[webview] ${message.message ?? ''}`);
        break;
      default:
        break;
    }
  }

  private postContent(entry: PanelEntry): void {
    const { content } = entry;
    const sourceUrl = 'sourceUrl' in content ? content.sourceUrl : undefined;
    // 文件名 / 本地路径这几个字段所有非 none 的分支都有。
    const meta =
      content.kind === 'none'
        ? {}
        : {
            filename: content.filename,
            extension: content.extension,
            savedPath: content.savedPath,
            byteLength: content.byteLength,
          };

    switch (content.kind) {
      case 'pdf':
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'pdf',
          base64: Buffer.from(content.data).toString('base64'),
          sourceUrl,
          ...meta,
        });
        break;
      case 'docx':
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'docx',
          publicUrl: content.publicUrl,
          sourceUrl,
          hasLocalCopy: !!content.data,
          mode: entry.config.docxPreview,
          ...meta,
        });
        break;
      case 'txt':
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'txt',
          text: content.text,
          sourceUrl,
          ...meta,
        });
        break;
      case 'html':
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'html',
          html: sanitizeStatementHtml(content.html),
          sourceUrl,
          ...meta,
        });
        break;
      case 'binary':
        // .doc / .xls / .zip 这类：编辑器渲染不了，引导去本地打开。
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'binary',
          sourceUrl,
          ...meta,
        });
        break;
      case 'none':
      default:
        void entry.panel.webview.postMessage({
          type: 'content',
          kind: 'none',
          reason: content.reason,
          sourceUrl,
        });
        break;
    }
  }

  private setActive(id: string | undefined): void {
    if (this.activeProblemId === id) {
      return;
    }
    this.activeProblemId = id;
    this.changeEmitter.fire(id);
  }

  /** 题面标签页获得焦点时把它记为「当前题目」。 */
  private syncActiveFromEditors(): void {
    const activeId = [...this.panels.values()].find((entry) => entry.panel.active)?.detail.id;
    this.setActive(activeId);
  }

  reveal(id: string): boolean {
    const entry = this.panels.get(id);
    if (!entry) {
      return false;
    }
    entry.panel.reveal(entry.panel.viewColumn, true);
    this.setActive(id);
    return true;
  }

  private buildHtml(entry: PanelEntry): string {
    const { panel, detail, config } = entry;
    const webview = panel.webview;
    const nonce = createNonce();

    const asUri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...parts)).toString();

    const styleUri = asUri('problem.css');
    const appUri = asUri('problem.js');
    const pdfUri = asUri('pdf.js');
    const cspSource = webview.cspSource;

    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} data: blob: https: http:`,
      `media-src ${cspSource} data: blob: https: http:`,
      `font-src ${cspSource} data:`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${cspSource} blob:`,
      `connect-src ${cspSource} blob: data:`,
      // Microsoft Office 在线预览是靠 iframe 嵌入的。
      `frame-src https://view.officeapps.live.com`,
      `worker-src blob: ${cspSource}`,
    ].join('; ');

    const statementUrl = detail.contentUrl
      ? resolveUrl(config.endpoint, detail.contentUrl)
      : undefined;

    const limits: string[] = [];
    if (detail.timeLimitMs !== undefined) {
      limits.push(`时限 ${detail.timeLimitMs} ms`);
    }
    if (detail.memoryLimitMb !== undefined) {
      limits.push(`内存 ${detail.memoryLimitMb} MB`);
    }
    if (detail.difficulty) {
      limits.push(detail.difficulty);
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>${escapeHtml(panelTitle(detail))}</title>
</head>
<body data-kind="${escapeHtml(detail.contentKind ?? 'none')}">
  <header class="toolbar" id="toolbar">
    <div class="toolbar-left">
      <span class="problem-id" title="题号">${escapeHtml(detail.id)}</span>
      <span class="problem-title" title="${escapeHtml(detail.title)}">${escapeHtml(detail.title)}</span>
      ${limits.length > 0 ? `<span class="limits">${escapeHtml(limits.join(' · '))}</span>` : ''}
    </div>
    <div class="toolbar-right" id="toolbar-actions">
      <span class="status" id="status" hidden></span>
      <button type="button" data-action="reload" title="重新拉取题面">重新加载</button>
      <button type="button" data-action="copy-url" title="复制题面原始地址"${statementUrl ? '' : ' hidden'}>复制地址</button>
      <button type="button" data-action="open-external" title="在系统浏览器中打开"${statementUrl ? '' : ' hidden'}>浏览器打开</button>
      <button type="button" data-action="open-local" title="用系统程序打开已下载的题面文件" hidden>打开文件</button>
      <button type="button" data-action="submit" title="提交当前打开的 cpp 文件">提交</button>
    </div>
  </header>
  <div class="pdf-toolbar" id="pdf-toolbar" hidden>
    <button type="button" data-pdf="prev" title="上一页">‹</button>
    <span class="page-indicator"><input id="pdf-page" type="number" min="1" value="1" /> / <span id="pdf-pages">?</span></span>
    <button type="button" data-pdf="next" title="下一页">›</button>
    <span class="sep"></span>
    <button type="button" data-pdf="zoom-out" title="缩小">−</button>
    <span id="pdf-zoom" class="zoom-label">100%</span>
    <button type="button" data-pdf="zoom-in" title="放大">+</button>
    <button type="button" data-pdf="fit-width">适应宽度</button>
    <span class="sep"></span>
    <label class="toggle"><input type="checkbox" id="pdf-scroll" checked /> 连续滚动</label>
  </div>
  <main id="content" class="content">
    <div class="placeholder">正在加载题面…</div>
  </main>
  <script nonce="${nonce}" type="module" src="${pdfUri}"></script>
  <script nonce="${nonce}" type="module" src="${appUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.panel.dispose();
    }
    this.panels.clear();
    this.changeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

interface WebviewMessage {
  type?: string;
  url?: string;
  path?: string;
  message?: string;
}

function panelTitle(detail: ProblemDetail): string {
  return `${detail.id} ${detail.title}`.trim();
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * 题面 HTML 直接注入页面。真正的防线是上面的 CSP（没有 nonce 的脚本、内联事件处理器
 * 都会被拦掉），这里只是顺手把明显的脚本标签摘掉，算是深度防御。
 */
function sanitizeStatementHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, 'javascript&#58;');
}
