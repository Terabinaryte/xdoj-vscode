import * as vscode from 'vscode';
import { VERDICT_LABEL, isSettled, type Submission, type TestCaseRun } from './api/types';
import { escapeHtml, formatRelativeTime } from './util/text';

export interface SubmissionPanelOptions {
  /** 题面已经有栏位就开在那里，免得每看一条提交都多一栏。 */
  column?: vscode.ViewColumn;
  /**
   * 逐测试点结果的加载器。不提供就不显示这一块
   * （OJ 没有这个接口，或者客户端不支持）。
   */
  loadRuns?: () => Promise<TestCaseRun[]>;
}

/** 单条提交的详情页：评测信息、编译错误、逐测试点结果。 */
export class SubmissionPanel {
  private static current: SubmissionPanel | undefined;

  static show(submission: Submission, options: SubmissionPanelOptions = {}): void {
    if (SubmissionPanel.current) {
      SubmissionPanel.current.update(submission, options);
      SubmissionPanel.current.panel.reveal(undefined, false);
      return;
    }
    SubmissionPanel.current = new SubmissionPanel(submission, options);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private runs: TestCaseRun[] | undefined;
  private runsError: string | undefined;
  private runsLoading = false;
  private loadRuns: (() => Promise<TestCaseRun[]>) | undefined;
  private disposed = false;

  private constructor(
    private submission: Submission,
    options: SubmissionPanelOptions,
  ) {
    this.loadRuns = options.loadRuns;
    this.panel = vscode.window.createWebviewPanel(
      'xdoj.submission',
      `提交 ${submission.id}`,
      options.column ?? vscode.ViewColumn.Beside,
      { enableScripts: false, localResourceRoots: [] },
    );
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    void this.refreshRuns();
  }

  private update(submission: Submission, options: SubmissionPanelOptions): void {
    const switched = submission.id !== this.submission.id;
    this.submission = submission;
    this.loadRuns = options.loadRuns ?? this.loadRuns;
    this.panel.title = `提交 ${submission.id}`;
    if (switched) {
      // 换了一条提交，旧的测试点结果不能留着。
      this.runs = undefined;
      this.runsError = undefined;
    }
    this.panel.webview.html = this.buildHtml();
    if (switched) {
      void this.refreshRuns();
    }
  }

  /** 拉逐测试点结果；失败就显示成一行提示，不影响其他内容。 */
  private async refreshRuns(): Promise<void> {
    if (!this.loadRuns || this.runs || this.runsError || this.runsLoading) {
      return;
    }
    const loader = this.loadRuns;
    const idAtStart = this.submission.id;
    this.runsLoading = true;
    try {
      const runs = await loader();
      if (this.disposed || this.submission.id !== idAtStart) {
        return;
      }
      this.runs = runs;
    } catch (error) {
      if (this.disposed || this.submission.id !== idAtStart) {
        return;
      }
      this.runsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.runsLoading = false;
      if (!this.disposed && this.submission.id === idAtStart) {
        this.panel.webview.html = this.buildHtml();
      }
    }
  }

  /** 测试点表格。`result` 只有 1 有实证，其余码原样显示，不猜。 */
  private runsSection(): string {
    if (!this.loadRuns) {
      return '';
    }
    if (this.runsError) {
      return `<h3>测试点</h3><p class="muted">取不到逐测试点结果：${escapeHtml(this.runsError)}</p>`;
    }
    if (!this.runs) {
      return '<h3>测试点</h3><p class="muted">正在加载…</p>';
    }
    if (this.runs.length === 0) {
      return '<h3>测试点</h3><p class="muted">服务端没有返回测试点数据。</p>';
    }

    const passed = this.runs.filter((run) => run.resultCode === '1').length;
    const body = this.runs
      .map((run, index) => {
        const ok = run.resultCode === '1';
        const result = ok
          ? '通过'
          : `未通过（result=${run.resultCode ?? '?'}）`;
        const time = run.runTimeMs !== undefined ? `${run.runTimeMs} ms` : '—';
        const memory = run.memoryKb !== undefined ? `${(run.memoryKb / 1024).toFixed(1)} MB` : '—';
        return (
          `<tr>` +
          `<td>${index + 1}</td>` +
          `<td>${escapeHtml(run.testcaseId ?? '—')}</td>` +
          `<td class="${ok ? 'ok' : 'bad'}">${escapeHtml(result)}</td>` +
          `<td>${escapeHtml(time)}</td>` +
          `<td>${escapeHtml(memory)}</td>` +
          `</tr>`
        );
      })
      .join('\n      ');

    return `<h3>测试点（${passed}/${this.runs.length} 通过）</h3>
  <table class="cases">
    <thead><tr><th class="idx">#</th><th class="idx">测试点</th><th class="idx">结果</th><th class="idx">耗时</th><th class="idx">内存</th></tr></thead>
    <tbody>
      ${body}
    </tbody>
  </table>`;
  }

  private buildHtml(): string {
    const s = this.submission;
    const nonce = Math.random().toString(36).slice(2);
    const verdictLabel = VERDICT_LABEL[s.verdict] ?? s.verdict;
    const settled = isSettled(s.verdict);

    const rows: Array<[string, string]> = [
      ['题目', s.problemId ? `${s.problemId} ${s.problemTitle ?? ''}`.trim() : '—'],
      ['状态', verdictLabel + (s.rawVerdict && s.rawVerdict !== s.verdict ? `（原始：${s.rawVerdict}）` : '')],
      ['语言', s.language ?? '—'],
      ['提交时间', s.createdAt ? `${new Date(s.createdAt).toLocaleString()}（${formatRelativeTime(s.createdAt)}）` : '—'],
      ['耗时', s.timeMs !== undefined ? `${s.timeMs} ms` : '—'],
      ['内存', s.memoryKb !== undefined ? `${(s.memoryKb / 1024).toFixed(1)} MB` : '—'],
      ['得分', s.score !== undefined ? String(s.score) : '—'],
      ['提交 ID', s.id],
    ];

    const csp = `default-src 'none'; style-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>提交 ${escapeHtml(s.id)}</title>
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 18px 22px 40px;
    line-height: 1.6;
  }
  h2 { margin: 0 0 4px; font-size: 1.15em; }
  .verdict {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-weight: 600;
    margin-bottom: 18px;
    background: var(--vscode-badge-background, rgba(128,128,128,.25));
    color: var(--vscode-badge-foreground, inherit);
  }
  .verdict.pass { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
  .verdict.fail { background: var(--vscode-testing-iconFailed, #be1100); color: #fff; }
  .verdict.wait { background: var(--vscode-testing-iconQueued, #cca700); color: #201f1e; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 5px 10px 5px 0; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  th { width: 7.5em; font-weight: 500; opacity: .7; white-space: nowrap; }
  pre {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 4px;
    padding: 12px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  h3 { margin: 26px 0 8px; font-size: 1em; }
  .muted { opacity: .65; }
  table.cases { max-width: 620px; }
  table.cases th.idx { width: auto; }
  table.cases td { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.15)); }
  td.ok { color: var(--vscode-testing-iconPassed, #388a34); }
  td.bad { color: var(--vscode-testing-iconFailed, #be1100); }
</style>
</head>
<body>
  <h2>${escapeHtml((s.problemId ?? '') + ' ' + (s.problemTitle ?? ''))}</h2>
  <div class="verdict ${s.verdict === 'accepted' ? 'pass' : settled ? 'fail' : 'wait'}">${escapeHtml(verdictLabel)}</div>
  <table>
    ${rows
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
      .join('\n    ')}
  </table>
  ${this.runsSection()}
  ${s.message ? `<h3>评测信息</h3><pre>${escapeHtml(s.message)}</pre>` : ''}
  ${s.compileOutput ? `<h3>编译 / 评测输出</h3><pre>${escapeHtml(s.compileOutput)}</pre>` : ''}
  ${!settled ? `<p class="muted">该提交仍在评测中，侧栏会自动刷新。</p>` : ''}
</body>
</html>`;
  }

  private dispose(): void {
    this.disposed = true;
    SubmissionPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
