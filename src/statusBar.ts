import * as vscode from 'vscode';
import { VERDICT_LABEL, isSettled } from './api/types';
import type { XdojService } from './service';

/** 状态栏一角：显示当前题目和最近一次提交结果，点一下打开题目侧栏。 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly service: XdojService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'xdoj.problems.focus';
    this.item.show();

    this.disposables.push(
      this.item,
      service.onDidChangeProblems(() => this.update()),
      service.submissions.onDidChange(() => this.update()),
      service.panels.onDidChangeActiveProblem(() => this.update()),
      service.session.onDidChange(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const problemId = this.service.panels.activeId;
    const problemLabel = problemId
      ? `${problemId} ${this.service.problemTitle(problemId)}`
      : this.service.isMock
        ? '未选择题目（样例数据）'
        : '未选择题目';

    const latest = this.service.submissions.all.find((s) => s.createdAt !== undefined);
    const verdictSuffix = latest ? ` · ${VERDICT_LABEL[latest.verdict] ?? latest.verdict}` : '';

    // 没配地址时最优先提示它 —— 这时候「未登录」会让人以为登录一下就好了。
    const noEndpoint = !this.service.isMock && !this.service.getConfig().endpoint;
    // 未登录时状态栏只显示登录状态，避免让人误以为请求已经能发出去。
    const loggedOut = !this.service.isMock && !this.service.session.isLoggedIn;
    const account = this.service.session.displayAccount;
    const body = noEndpoint
      ? '未配置地址'
      : loggedOut
        ? account || '未登录'
        : `${truncate(problemLabel, 40)}${verdictSuffix}`;
    this.item.text = `$(symbol-namespace) XDOJ: ${body}`;

    const authLine = this.service.isMock
      ? '数据源：内置样例数据'
      : noEndpoint
        ? '未配置地址 —— 设置里填 `xdoj.endpoint`'
        : this.service.session.isLoggedIn
          ? `已登录：${account || '(未知账户)'}`
          : '未登录 —— 命令面板运行「XDOJ: 登录」';

    this.item.tooltip = new vscode.MarkdownString(
      [
        '**XDOJ**',
        '',
        authLine,
        `地址：${this.service.getConfig().endpoint || '(未配置)'}`,
        `共 ${this.service.getProblems().length} 题`,
        latest
          ? `最近提交：${VERDICT_LABEL[latest.verdict] ?? latest.verdict}${
              isSettled(latest.verdict) ? '' : '（评测中）'
            }`
          : undefined,
        '',
        '点击打开题目侧栏',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n\n'),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
