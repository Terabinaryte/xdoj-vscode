import * as vscode from 'vscode';
import { VERDICT_LABEL, isSettled, type Submission, type Verdict } from '../api/types';
import { formatRelativeTime } from '../util/text';
import type { SubmissionStore } from './submissionStore';

export class SubmissionNode {
  constructor(readonly submission: Submission) {}
}

interface VerdictVisual {
  icon: string;
  color?: string;
}

const VERDICT_VISUALS: Record<Verdict, VerdictVisual> = {
  pending: { icon: 'clock', color: 'testing.iconQueued' },
  judging: { icon: 'sync~spin', color: 'testing.iconQueued' },
  accepted: { icon: 'pass-filled', color: 'testing.iconPassed' },
  wrong_answer: { icon: 'close', color: 'testing.iconFailed' },
  presentation_error: { icon: 'warning', color: 'testing.iconFailed' },
  time_limit_exceeded: { icon: 'watch', color: 'testing.iconFailed' },
  memory_limit_exceeded: { icon: 'database', color: 'testing.iconFailed' },
  output_limit_exceeded: { icon: 'output', color: 'testing.iconFailed' },
  runtime_error: { icon: 'bug', color: 'testing.iconFailed' },
  compile_error: { icon: 'warning', color: 'testing.iconFailed' },
  system_error: { icon: 'error', color: 'testing.iconFailed' },
  unknown: { icon: 'question', color: 'testing.iconUnset' },
};

/** 提交记录列表。全部拉平展示，最新的在最上面。 */
export class SubmissionTreeProvider
  implements vscode.TreeDataProvider<SubmissionNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: SubmissionStore) {
    this.disposables.push(store.onDidChange(() => this.emitter.fire()));
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: SubmissionNode): vscode.TreeItem {
    const { submission } = element;
    const label = submission.problemId
      ? `${submission.problemId}  ${submission.problemTitle ?? ''}`.trim()
      : `提交 ${shortId(submission.id)}`;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `submission:${submission.id}`;
    item.contextValue = 'xdoj.submission';

    const visual = VERDICT_VISUALS[submission.verdict] ?? VERDICT_VISUALS.unknown;
    item.iconPath = visual.color
      ? new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color))
      : new vscode.ThemeIcon(visual.icon);

    const parts = [VERDICT_LABEL[submission.verdict] ?? submission.verdict];
    // XDOJ 的提交列表不给真实耗时/内存（恒为 0），显示成「0 ms · 0 KB」纯属噪音。
    // 只有真拿到非零值时才展示，免得一排「通过 · 0 ms · 0 KB · 5 天前」。
    if (isSettled(submission.verdict)) {
      if (submission.timeMs) {
        parts.push(`${submission.timeMs} ms`);
      }
      if (submission.memoryKb) {
        parts.push(formatMemory(submission.memoryKb));
      }
    }
    if (submission.createdAt !== undefined) {
      parts.push(formatRelativeTime(submission.createdAt));
    }
    item.description = parts.join(' · ');

    const tooltipLines = [
      `**${label}**`,
      '',
      `状态：${VERDICT_LABEL[submission.verdict] ?? submission.verdict}` +
        (submission.rawVerdict && submission.rawVerdict !== submission.verdict
          ? `（原始：${submission.rawVerdict}）`
          : ''),
    ];
    if (submission.language) {
      tooltipLines.push(`语言：${submission.language}`);
    }
    if (submission.timeMs) {
      tooltipLines.push(`耗时：${submission.timeMs} ms`);
    }
    if (submission.memoryKb) {
      tooltipLines.push(`内存：${formatMemory(submission.memoryKb)}`);
    }
    if (submission.score !== undefined) {
      tooltipLines.push(`得分：${submission.score}`);
    }
    if (submission.message) {
      tooltipLines.push('', '```', submission.message.slice(0, 400), '```');
    }
    tooltipLines.push('', `提交 ID：\`${submission.id}\``, '', '点击查看详情');
    item.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));

    item.command = {
      command: 'xdoj.openSubmission',
      title: '查看提交详情',
      arguments: [submission.id],
    };
    return item;
  }

  getChildren(element?: SubmissionNode): SubmissionNode[] {
    if (element) {
      return [];
    }
    return this.store.all.map((s) => new SubmissionNode(s));
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function formatMemory(kb: number): string {
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`;
  }
  return `${Math.round(kb)} KB`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
