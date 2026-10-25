import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import {
  OjError,
  type Contest,
  type OjClient,
  type ProblemContent,
  type ProblemDetail,
  type ProblemSummary,
  type SubmitInput,
  type SubmitResult,
  type Submission,
  type Verdict,
} from './types';
import { log } from '../logger';

/**
 * 内置假数据客户端。
 *
 * 目的只有一个：在还没接上真实 OJ 的时候，让侧栏、题面渲染（PDF/DOCX/TXT/HTML）
 * 和提交状态流转都能立刻跑起来。关掉 `xdoj.useMockData` 后即切换到真实接口。
 */
export class MockOjClient implements OjClient {
  readonly label = '内置样例数据';

  private readonly submissions = new Map<string, Submission>();
  private readonly submitTimeline = new Map<string, number>();
  private seq = 0;

  private readonly problems: ProblemSummary[] = [
    { id: 'sample-problem-a', title: 'A + B Problem', difficulty: '入门', tags: ['模拟'], accepted: true },
    { id: 'sample-problem-b', title: '最大子段和', difficulty: '简单', tags: ['DP', '贪心'] },
    { id: 'sample-problem-c', title: '区间调度', difficulty: '简单', tags: ['贪心', '排序'], accepted: true },
    { id: 'sample-problem-d', title: '并查集模板', difficulty: '中等', tags: ['数据结构'] },
    { id: 'sample-problem-e', title: '单源最短路', difficulty: '中等', tags: ['图论'] },
    { id: 'sample-problem-f', title: '实验报告模板', difficulty: '入门', tags: ['文档'] },
  ];

  /** 模拟 XDOJ 的「比赛 → 题目」结构。 */
  private readonly contests: Array<Omit<Contest, 'problemCount'>> = [
    {
      id: 'sample-contest',
      title: '示例比赛（进行中）',
      statusString: 'Ready',
      description: '示例比赛说明',
      startTime: '2026-01-05 14:00:00',
      endTime: '2026-01-12 23:59:00',
      started: true,
      running: true,
      active: true,
    },
    {
      id: 'sample-contest-2',
      title: '示例比赛（已结束）',
      statusString: 'Ready',
      description: '贪心与排序',
      startTime: '2026-01-03 08:00:00',
      endTime: '2026-01-03 11:30:00',
      started: true,
      running: false,
      active: true,
    },
    {
      id: 'sample-contest-3',
      title: '示例比赛（未开始）',
      statusString: 'Pending',
      description: '图论专题',
      startTime: '2026-02-01 09:00:00',
      endTime: '2026-02-01 12:00:00',
      started: false,
      running: false,
      active: false,
    },
  ];

  private readonly contestProblemIds: Record<string, string[]> = {
    'sample-contest': ['sample-problem-a', 'sample-problem-b'],
    'sample-contest-2': ['sample-problem-c', 'sample-problem-d'],
    'sample-contest-3': ['sample-problem-e', 'sample-problem-f'],
  };

  constructor(private readonly extensionUri: vscode.Uri) {
    this.seedHistory();
  }

  async listContests(): Promise<Contest[]> {
    await delay(150);
    return this.contests.map((c) => ({
      ...c,
      problemCount: this.contestProblemIds[c.id]?.length ?? 0,
    }));
  }

  async getContestProblems(contestId: string): Promise<ProblemSummary[]> {
    await delay(120);
    const ids = this.contestProblemIds[contestId];
    if (!ids) {
      throw new OjError(`样例数据里没有比赛 ${contestId}`);
    }
    return ids
      .map((id) => this.problems.find((p) => p.id === id))
      .filter((p): p is ProblemSummary => !!p)
      .map((p) => ({ ...p, contestId, tags: [...p.tags] }));
  }

  async listProblems(): Promise<ProblemSummary[]> {
    await delay(120);
    return this.problems.map((p) => ({ ...p, tags: [...p.tags] }));
  }

  async getProblem(id: string): Promise<ProblemDetail> {
    await delay(80);
    const summary = this.problems.find((p) => p.id === id);
    if (!summary) {
      throw new OjError(`样例数据里没有题号 ${id}（可用：${this.problems.map((p) => p.id).join(', ')}）`);
    }
    const detail: ProblemDetail = { ...summary, tags: [...summary.tags] };
    switch (id) {
      case 'sample-problem-b':
        detail.contentUrl = 'sample-statement.pdf';
        detail.contentKind = 'pdf';
        detail.timeLimitMs = 1000;
        detail.memoryLimitMb = 256;
        break;
      case 'sample-problem-c':
        detail.contentUrl = 'sample-statement.docx';
        detail.contentKind = 'docx';
        detail.timeLimitMs = 2000;
        detail.memoryLimitMb = 128;
        break;
      case 'sample-problem-d':
        detail.contentKind = 'html';
        detail.inlineContent = { kind: 'html', body: MOCK_HTML_STATEMENT };
        detail.timeLimitMs = 1500;
        detail.memoryLimitMb = 256;
        break;
      case 'sample-problem-e':
        detail.timeLimitMs = 3000;
        detail.memoryLimitMb = 512;
        break;
      case 'sample-problem-f':
        detail.contentKind = 'binary';
        detail.timeLimitMs = 1000;
        detail.memoryLimitMb = 64;
        break;
      default:
        detail.contentKind = 'txt';
        detail.timeLimitMs = 1000;
        detail.memoryLimitMb = 128;
        break;
    }
    return detail;
  }

  async loadContent(detail: ProblemDetail): Promise<ProblemContent> {
    if (detail.inlineContent) {
      const bytes = new TextEncoder().encode(detail.inlineContent.body);
      const meta = { byteLength: bytes.byteLength };
      return detail.inlineContent.kind === 'html'
        ? { ...meta, kind: 'html', html: detail.inlineContent.body, data: bytes }
        : { ...meta, kind: 'txt', text: detail.inlineContent.body, data: bytes };
    }

    // 按题号分派：真实流程里详情接口可能是留空的，不能依赖 detail.contentKind。
    if (detail.id === 'sample-problem-a' || detail.contentKind === 'txt') {
      const bytes = new TextEncoder().encode(MOCK_TXT_STATEMENT);
      return {
        kind: 'txt',
        text: MOCK_TXT_STATEMENT,
        data: bytes,
        filename: `${detail.id}-statement.txt`,
        extension: 'txt',
        sourceUrl: 'mock://sample-statement.txt',
        byteLength: bytes.byteLength,
      };
    }

    if (detail.id === 'sample-problem-b' || detail.contentKind === 'pdf') {
      const data = await this.readSample('sample-statement.pdf');
      return {
        kind: 'pdf',
        data,
        filename: 'sample-statement.pdf',
        extension: 'pdf',
        sourceUrl: 'mock://sample-statement.pdf',
        byteLength: data.byteLength,
      };
    }

    if (detail.id === 'sample-problem-c' || detail.contentKind === 'docx') {
      const data = await this.readSample('sample-statement.docx');
      return {
        kind: 'docx',
        data,
        filename: 'sample-statement.docx',
        extension: 'docx',
        sourceUrl: 'mock://sample-statement.docx',
        // 在线预览需要公网可匿名访问的地址；样例借一个公开 demo 文件演示 iframe。
        publicUrl: 'https://calibre-ebook.com/downloads/demos/demo.docx',
        byteLength: data.byteLength,
      };
    }

    if (detail.id === 'sample-problem-d' || detail.contentKind === 'html') {
      const bytes = new TextEncoder().encode(MOCK_HTML_STATEMENT);
      return {
        kind: 'html',
        html: MOCK_HTML_STATEMENT,
        data: bytes,
        filename: `${detail.id}-statement.html`,
        extension: 'html',
        byteLength: bytes.byteLength,
      };
    }

    if (detail.id === 'sample-problem-f') {
      // 模拟「返回一个 .doc」：编辑器渲染不了，只能下载后用本地程序打开。
      const data = await this.readSample('sample-statement.doc');
      return {
        kind: 'binary',
        data,
        filename: '实验报告模板.doc',
        extension: 'doc',
        sourceUrl: 'mock://sample-statement.doc',
        byteLength: data.byteLength,
      };
    }

    return { kind: 'none', reason: '这道样例题故意没有配题面附件，用来演示兜底提示。' };
  }

  /** 样例数据里直接给一个假的班级编号，方便跑通 multipart 提交。 */
  async loadSubmitPage(_problemId: string, contestId?: string): Promise<Record<string, string>> {
    await delay(40);
    return {
      solutionType: '0',
      contestId: contestId ?? 'sample-contest',
      userId: '样例用户',
      classId: 'sample-class',
    };
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    await delay(260);
    if (!input.code.trim()) {
      throw new OjError('代码为空，样例客户端拒绝提交');
    }
    this.seq += 1;
    const id = `mock-${Date.now().toString(36)}-${this.seq}`;
    const submission: Submission = {
      id,
      problemId: input.problemId,
      problemTitle: this.problems.find((p) => p.id === input.problemId)?.title,
      verdict: 'pending',
      language: input.language,
      createdAt: Date.now(),
    };
    this.submissions.set(id, submission);
    this.submitTimeline.set(id, 0);
    log.info(`[mock] 已接收提交 ${id}（题目 ${input.problemId}，${input.code.length} 字节）`);
    return { submissionId: id };
  }

  async getSubmission(id: string, _contestId?: string): Promise<Submission | undefined> {
    const submission = this.submissions.get(id);
    if (!submission) {
      return undefined;
    }
    // 每次轮询推进一步，模拟 排队 → 评测中 → 出结果。
    const step = (this.submitTimeline.get(id) ?? 0) + 1;
    this.submitTimeline.set(id, step);

    if (step <= 1) {
      submission.verdict = 'judging';
    } else if (step === 2) {
      submission.verdict = 'judging';
      submission.timeMs = 120 + Math.round(Math.random() * 400);
      submission.memoryKb = 1024 * (2 + Math.round(Math.random() * 12));
    } else if (step === 3) {
      const verdict = this.pickVerdict(id);
      submission.verdict = verdict;
      submission.timeMs = 120 + Math.round(Math.random() * 700);
      submission.memoryKb = 1024 * (2 + Math.round(Math.random() * 14));
      if (verdict === 'compile_error') {
        submission.compileOutput = [
          'main.cpp:12:15: error: expected \';\' before \'}\' token',
          '   12 |     return 0',
          '      |             ^',
          '      |             ;',
          'main.cpp:13:1: error: expected declaration before \'}\' token',
        ].join('\n');
      }
    }
    return { ...submission };
  }

  async listSubmissions(_contestId?: string): Promise<Submission[]> {
    await delay(90);
    return [...this.submissions.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((s) => ({ ...s }));
  }

  /** 让样例提交的结果按下标轮转，方便看到各种状态。 */
  private pickVerdict(id: string): Verdict {
    const order: Verdict[] = [
      'accepted',
      'wrong_answer',
      'time_limit_exceeded',
      'compile_error',
      'runtime_error',
      'memory_limit_exceeded',
    ];
    const submission = this.submissions.get(id);
    // 题号是字符串标识，不保证是数字：用稳定的哈希决定判定，
    // 这样同一道题的样例提交结果固定，也不会因为 Number.parseInt 得到 NaN 而退化成计数器。
    let hash = this.seq;
    if (submission?.problemId) {
      hash = 0;
      for (const char of submission.problemId) {
        hash = (hash * 31 + char.codePointAt(0)!) % 100_000;
      }
    }
    return order[hash % order.length];
  }

  private seedHistory(): void {
    const now = Date.now();
    const seeds: Array<[Verdict, string, string, number]> = [
      ['accepted', 'sample-problem-a', 'cpp', 3 * 60_000],
      ['wrong_answer', 'sample-problem-b', 'cpp', 26 * 60_000],
      ['accepted', 'sample-problem-b', 'cpp', 31 * 60_000],
      ['compile_error', 'sample-problem-c', 'cpp', 3 * 3600_000],
      ['accepted', 'sample-problem-c', 'cpp', 3 * 3600_000 + 4 * 60_000],
    ];
    seeds.forEach(([verdict, problemId, language, ago], i) => {
      const id = `mock-history-${i + 1}`;
      this.submissions.set(id, {
        id,
        problemId,
        problemTitle: this.problems.find((p) => p.id === problemId)?.title,
        verdict,
        rawVerdict: verdict,
        language,
        createdAt: now - ago,
        timeMs: 90 + i * 137,
        memoryKb: 1024 * (3 + i),
        compileOutput:
          verdict === 'compile_error'
            ? "main.cpp:5:10: error: 'n' was not declared in this scope"
            : undefined,
      });
    });
  }

  private async readSample(name: string): Promise<Uint8Array> {
    const uri = vscode.Uri.joinPath(this.extensionUri, 'media', name);
    try {
      return new Uint8Array(await readFile(uri.fsPath));
    } catch (error) {
      throw new OjError(`读取内置样例文件失败：${uri.fsPath}`, error);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MOCK_TXT_STATEMENT = `XDOJ sample-problem-a - A + B Problem
========================================

Time limit: 1000 ms
Memory limit: 128 MB

Description
----------------------------------------
Compute the sum of two integers a and b.

Input
----------------------------------------
A single line containing two integers a and b
(-10^9 <= a, b <= 10^9), separated by a space.

Output
----------------------------------------
A single integer: a + b.

Sample Input
----------------------------------------
1 2

Sample Output
----------------------------------------
3

Hint
----------------------------------------
这道题的题面以纯文本形式返回，所以是直接在标签页里
用等宽字体渲染的。真实 OJ 只要返回 text/plain 即可。
`;

const MOCK_HTML_STATEMENT = `
<section class="mock-statement">
  <h2>sample-problem-d · 并查集模板</h2>
  <p class="meta">Time limit: 1500 ms　Memory limit: 256 MB</p>
  <h3>题目描述</h3>
  <p>维护一个由 <code>n</code> 个元素组成的集合，支持两种操作：</p>
  <ul>
    <li><code>1 x y</code>：合并 <code>x</code> 与 <code>y</code> 所在的集合；</li>
    <li><code>2 x y</code>：询问 <code>x</code> 与 <code>y</code> 是否属于同一集合。</li>
  </ul>
  <h3>输入格式</h3>
  <p>第一行两个整数 <code>n, m</code>。接下来 <code>m</code> 行，每行一个操作。</p>
  <h3>输出格式</h3>
  <p>对每个操作 2，输出一行 <code>Y</code> 或 <code>N</code>。</p>
  <h3>样例</h3>
  <pre>4 5
1 1 2
2 1 2
1 3 4
2 1 3
2 1 4</pre>
  <pre>Y
N
N</pre>
  <p class="hint">这段题面是 HTML，直接内联在详情响应里返回。</p>
</section>
`;
