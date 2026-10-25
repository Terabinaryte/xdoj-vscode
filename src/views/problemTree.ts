import * as vscode from 'vscode';
import type { Contest, ProblemSummary } from '../api/types';

export class ContestNode {
  constructor(readonly contest: Contest) {}
}

export class ProblemNode {
  constructor(readonly problem: ProblemSummary) {}
}

/** 用来在树里显示一行说明（加载失败、暂无数据等）。 */
export class MessageNode {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly icon = 'info',
  ) {}
}

export type ProblemTreeElement = ContestNode | ProblemNode | MessageNode;

export interface ProblemTreeDeps {
  /** 当前 OJ 是否按比赛组织题目。 */
  hasContests(): boolean;
  getContests(): Contest[];
  /** 扁平模式下的全部题目。 */
  getProblems(): ProblemSummary[];
  /** 懒加载某场比赛下的题目。 */
  loadContestProblems(contest: Contest): Promise<ProblemSummary[]>;
  onDidChangeProblems: vscode.Event<void>;
}

/**
 * 侧栏题目树。
 *
 * 两种形态：
 * - **比赛模式**（配置了 `xdoj.endpoints.contests`）：两级树，比赛 → 题目，展开时才去拉题目。
 * - **扁平模式**：一级列表，就是全部题目。
 *
 * 过滤在两种模式下都只作用于当前层级。
 */
export class ProblemTreeProvider
  implements vscode.TreeDataProvider<ProblemTreeElement>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  private filter = '';
  /** 比赛题目缓存，避免每次重绘都打一次请求。 */
  private readonly contestProblems = new Map<string, ProblemSummary[]>();
  private readonly inFlight = new Map<string, Promise<ProblemSummary[]>>();

  constructor(private readonly deps: ProblemTreeDeps) {
    this.disposables.push(
      deps.onDidChangeProblems(() => {
        // 比赛列表变了，之前缓存的题目可能已经过期。
        this.contestProblems.clear();
        this.refresh();
      }),
    );
  }

  refresh(): void {
    this.contestProblems.clear();
    this.emitter.fire();
  }

  setFilter(filter: string): void {
    this.filter = filter.trim().toLowerCase();
    this.refresh();
  }

  getFilter(): string {
    return this.filter;
  }

  getTreeItem(element: ProblemTreeElement): vscode.TreeItem {
    if (element instanceof ContestNode) {
      return this.contestItem(element.contest);
    }
    if (element instanceof MessageNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.tooltip = element.description;
      return item;
    }
    return this.problemItem(element.problem);
  }

  async getChildren(element?: ProblemTreeElement): Promise<ProblemTreeElement[]> {
    if (element instanceof ProblemNode || element instanceof MessageNode) {
      return [];
    }
    if (element instanceof ContestNode) {
      return this.contestChildren(element.contest);
    }
    return this.rootChildren();
  }

  private rootChildren(): ProblemTreeElement[] {
    if (this.deps.hasContests()) {
      const contests = this.deps.getContests();
      const filtered = this.filter
        ? contests.filter(
            (c) =>
              c.title.toLowerCase().includes(this.filter) ||
              c.id.toLowerCase().includes(this.filter) ||
              (c.description ?? '').toLowerCase().includes(this.filter),
          )
        : contests;
      if (filtered.length === 0 && this.filter) {
        return [new MessageNode('没有匹配的比赛', `过滤条件：${this.filter}`, 'search')];
      }
      return [...filtered].sort(compareContest).map((c) => new ContestNode(c));
    }

    const problems = this.visibleProblems(this.deps.getProblems());
    if (problems.length === 0 && this.filter) {
      return [new MessageNode('没有匹配的题目', `过滤条件：${this.filter}`, 'search')];
    }
    return problems.map((p) => new ProblemNode(p));
  }

  private async contestChildren(contest: Contest): Promise<ProblemTreeElement[]> {
    if (contest.inlineProblems && contest.inlineProblems.length > 0) {
      return this.visibleProblems(contest.inlineProblems).map((p) => new ProblemNode(p));
    }

    const cached = this.contestProblems.get(contest.id);
    if (cached) {
      return this.problemNodes(cached);
    }

    try {
      const problems = await this.loadContestProblems(contest);
      return this.problemNodes(problems);
    } catch (error) {
      return [
        new MessageNode(
          '加载题目失败',
          error instanceof Error ? error.message : String(error),
          'warning',
        ),
      ];
    }
  }

  private loadContestProblems(contest: Contest): Promise<ProblemSummary[]> {
    let pending = this.inFlight.get(contest.id);
    if (!pending) {
      pending = this.deps
        .loadContestProblems(contest)
        .then((problems) => {
          this.contestProblems.set(contest.id, problems);
          return problems;
        })
        .finally(() => {
          this.inFlight.delete(contest.id);
        });
      this.inFlight.set(contest.id, pending);
    }
    return pending;
  }

  private problemNodes(problems: ProblemSummary[]): ProblemTreeElement[] {
    const visible = this.visibleProblems(problems);
    if (visible.length === 0) {
      return [
        new MessageNode(
          this.filter ? '没有匹配的题目' : '这场比赛还没有题目',
          this.filter ? `过滤条件：${this.filter}` : '题目列表为空',
          this.filter ? 'search' : 'info',
        ),
      ];
    }
    return visible.map((p) => new ProblemNode(p));
  }

  private visibleProblems(problems: ProblemSummary[]): ProblemSummary[] {
    const filtered = this.filter
      ? problems.filter(
          (p) =>
            p.id.toLowerCase().includes(this.filter) ||
            p.title.toLowerCase().includes(this.filter) ||
            p.tags.some((t) => t.toLowerCase().includes(this.filter)),
        )
      : problems;
    return [...filtered].sort(compareProblem);
  }

  private contestItem(contest: Contest): vscode.TreeItem {
    const item = new vscode.TreeItem(contest.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `contest:${contest.id}`;
    item.contextValue = 'xdoj.contest';

    const inlined = contest.inlineProblems?.length ?? contest.problemCount;
    const parts: string[] = [];
    if (contest.statusString) {
      parts.push(contest.statusString);
    }
    const range = formatTimeRange(contest.startTime, contest.endTime);
    if (range) {
      parts.push(range);
    }
    if (inlined !== undefined) {
      parts.push(`${inlined} 题`);
    }
    item.description = parts.join(' · ');

    item.iconPath = contestIcon(contest);

    const lines = [`**${contest.title}**`, '', `比赛编号：\`${contest.id}\``];
    if (contest.description) {
      lines.push('', contest.description);
    }
    if (range) {
      lines.push('', `时间：${contest.startTime ?? '?'} ~ ${contest.endTime ?? '?'}`);
    }
    lines.push('', '展开查看题目');
    item.tooltip = new vscode.MarkdownString(lines.join('\n'));
    return item;
  }

  private problemItem(problem: ProblemSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${problem.id}  ${problem.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = problem.contestId
      ? `problem:${problem.contestId}:${problem.id}`
      : `problem:${problem.id}`;
    item.contextValue = 'xdoj.problem';
    item.iconPath = problem.accepted
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-outline');

    const descriptionParts: string[] = [];
    if (problem.difficulty) {
      descriptionParts.push(problem.difficulty);
    }
    if (problem.tags.length > 0) {
      descriptionParts.push(problem.tags.slice(0, 3).join('·'));
    }
    item.description = descriptionParts.join(' ');

    const difficultyText = problem.difficulty
      ? problem.difficultyRaw !== undefined && problem.difficultyRaw.toString() !== problem.difficulty
        ? `${problem.difficulty}（原始值 ${problem.difficultyRaw}）`
        : problem.difficulty
      : undefined;

    item.tooltip = new vscode.MarkdownString(
      [
        `**${problem.id}　${problem.title}**`,
        '',
        difficultyText ? `难度：${difficultyText}` : undefined,
        problem.tags.length > 0 ? `标签：${problem.tags.join('、')}` : undefined,
        problem.timeLimitMs !== undefined ? `时限：${problem.timeLimitMs} ms` : undefined,
        problem.memoryLimitMb !== undefined ? `内存：${problem.memoryLimitMb} MB` : undefined,
        problem.accepted === true
          ? '状态：已通过'
          : problem.accepted === false
            ? '状态：未通过'
            : undefined,
        '',
        '点击打开题面',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n\n'),
    );

    item.command = {
      command: 'xdoj.openProblem',
      title: '打开题目',
      arguments: [problem.id],
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** 正在进行的排最前，其余按开始时间/编号倒序，最新的在上。 */
function compareContest(a: Contest, b: Contest): number {
  const runningRank = (c: Contest) => (c.running ? 0 : c.started ? 1 : 2);
  const diff = runningRank(a) - runningRank(b);
  if (diff !== 0) {
    return diff;
  }
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return nb - na;
  }
  return b.id.localeCompare(a.id, 'zh-Hans-CN', { numeric: true });
}

function compareProblem(a: ProblemSummary, b: ProblemSummary): number {
  // 比赛内有 orderId 时它才是真正的顺序（对应 A/B/C…），题号只是数据库主键。
  if (a.orderId !== undefined && b.orderId !== undefined && a.orderId !== b.orderId) {
    return a.orderId - b.orderId;
  }
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na - nb;
  }
  return a.id.localeCompare(b.id, 'zh-Hans-CN', { numeric: true });
}

function contestIcon(contest: Contest): vscode.ThemeIcon {
  if (contest.running) {
    return new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconQueued'));
  }
  if (contest.started) {
    return new vscode.ThemeIcon('vm-outline');
  }
  return new vscode.ThemeIcon('calendar');
}

/** `2026-01-05 14:00:00` → `01-05 14:00`，省点侧栏宽度。 */
function formatTimeRange(start?: string, end?: string): string | undefined {
  const short = (value?: string): string | undefined => {
    if (!value) {
      return undefined;
    }
    const match = /^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(value.trim());
    return match ? `${match[1]} ${match[2]}` : value;
  };
  const s = short(start);
  const e = short(end);
  if (!s && !e) {
    return undefined;
  }
  return `${s ?? '?'} ~ ${e ?? '?'}`;
}
