/** 与具体 OJ 解耦的数据模型。 */

export type ContentKind = 'pdf' | 'docx' | 'txt' | 'html' | 'binary' | 'none';

export interface ProblemSummary {
  id: string;
  title: string;
  /** 所属比赛；扁平模式的 OJ 没有这个字段。 */
  contestId?: string;
  difficulty?: string;
  /** OJ 原始的难度数值（XDOJ 用 1/2/3…），用于 tooltip 展示。 */
  difficultyRaw?: number;
  tags: string[];
  /** 题目在比赛内的序号（XDOJ 的 orderId，对应 A/B/C…）。 */
  orderId?: number;
  timeLimitMs?: number;
  memoryLimitMb?: number;
  /** OJ 返回的通过状态，未知时为 undefined。 */
  accepted?: boolean;
}

/**
 * 比赛 / 场次。
 *
 * XDOJ 的题目挂在比赛下面（`contest/list.do` 返回比赛，比赛里有 `problems`），
 * 所以侧栏是「比赛 → 题目」两级树。
 */
export interface Contest {
  id: string;
  title: string;
  /** 服务端给的状态文案，例如 "Ready"。 */
  statusString?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  started?: boolean;
  running?: boolean;
  active?: boolean;
  /** 列表接口里给出题目数量时的提示；为 0 表示要展开才能知道。 */
  problemCount?: number;
  /** 列表接口若直接把题目内联在里面，就直接用，省一次请求。 */
  inlineProblems?: ProblemSummary[];
}

export interface ProblemDetail extends ProblemSummary {
  /** 题面原始地址（可能是相对路径，展示前会补全）。 */
  contentUrl?: string;
  /** 已从 OJ 明确得知的类型；未给出时按 contentUrl 扩展名推断。 */
  contentKind?: ContentKind;
  /** OJ 直接把题面内联在详情响应里时使用。 */
  inlineContent?: { kind: 'txt' | 'html'; body: string };
  timeLimitMs?: number;
  memoryLimitMb?: number;
}

/** 题面文件的元信息。 */
export interface StatementMeta {
  /** 服务端给的文件名（从 Content-Disposition 解析）。 */
  filename?: string;
  /** 小写扩展名，用于在界面上显示「.doc」这类提示。 */
  extension?: string;
  /** 落到本地的绝对路径；没配下载目录时为 undefined。 */
  savedPath?: string;
  /** 题面附件原始地址。 */
  sourceUrl?: string;
  byteLength?: number;
}

/**
 * 题面内容。
 *
 * `binary` 是兜底：.doc / .xls / .zip 这类编辑器渲染不了的东西，
 * 扩展会把文件存到本地，然后引导用户用系统程序打开。
 */
export type ProblemContent =
  | (StatementMeta & { kind: 'pdf'; data: Uint8Array })
  | (StatementMeta & { kind: 'docx'; data?: Uint8Array; publicUrl?: string })
  | (StatementMeta & { kind: 'txt'; data: Uint8Array; text: string })
  | (StatementMeta & { kind: 'html'; data: Uint8Array; html: string })
  | (StatementMeta & { kind: 'binary'; data?: Uint8Array })
  | { kind: 'none'; reason: string; sourceUrl?: string };

export type Verdict =
  | 'pending'
  | 'judging'
  | 'accepted'
  | 'wrong_answer'
  | 'presentation_error'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'output_limit_exceeded'
  | 'runtime_error'
  | 'compile_error'
  | 'system_error'
  | 'unknown';

export const VERDICT_LABEL: Record<Verdict, string> = {
  pending: '排队中',
  judging: '评测中',
  accepted: '通过',
  wrong_answer: '答案错误',
  presentation_error: '格式错误',
  time_limit_exceeded: '超时',
  memory_limit_exceeded: '超内存',
  output_limit_exceeded: '输出超限',
  runtime_error: '运行错误',
  compile_error: '编译错误',
  system_error: '系统错误',
  unknown: '未知',
};

export function isSettled(verdict: Verdict): boolean {
  return verdict !== 'pending' && verdict !== 'judging';
}

export function isSuccess(verdict: Verdict): boolean {
  return verdict === 'accepted';
}

export interface Submission {
  id: string;
  problemId?: string;
  problemTitle?: string;
  verdict: Verdict;
  /** OJ 原始状态文本，用于对不上映射时兜底展示。 */
  rawVerdict?: string;
  language?: string;
  /** OJ 的语言编号（XDOJ 的 languageId）。 */
  languageId?: number;
  createdAt?: number;
  timeMs?: number;
  memoryKb?: number;
  score?: number;
  message?: string;
  compileOutput?: string;
  /** 服务端给这次评测的 judgeId（逐测试点结果要用它查）。 */
  judgeId?: string;
  /** 本地刚提交、OJ 尚未返回记录时使用。 */
  localOnly?: boolean;
}

/**
 * 单个测试点的评测结果（XDOJ 的 `submission/listAllJudgeRun.do`）。
 *
 * 样例：`{"id":"<行ID>","judgeId":0,"memory":0,"output":[],"result":1,
 *        "runTime":14,"testcaseDescription":"","testcaseId":"<测试点ID>"}`
 */
export interface TestCaseRun {
  /** 测试点编号（服务端字段 testcaseId）。 */
  testcaseId?: string;
  /**
   * 服务端原始结果码。**只有 1 有实证**（通过），其余不猜，
   * 界面上原样展示成「未通过（result=N）」。
   */
  resultCode?: string;
  runTimeMs?: number;
  memoryKb?: number;
}

export interface SubmitInput {
  problemId: string;
  /** 题目所属比赛。XDOJ 的提交表单里有这个隐藏字段。 */
  contestId?: string;
  /** 班级编号。由服务端渲染进提交页，扩展会自动刮出来。 */
  classId?: string;
  language: string;
  /** 源码文本。没有原始字节、或源码要放进 `{code}` 字段时使用。 */
  code: string;
  /**
   * 源码的**原始字节**。
   *
   * 文件可能是 GB2312 / GB18030 之类，把 `code` 重新按 UTF-8 编码会改变内容，
   * 所以能拿到磁盘字节时优先用它。
   */
  codeBytes?: Uint8Array;
  filename: string;
}

export interface SubmitResult {
  /**
   * 提交 ID。
   * **可能没有** —— XDOJ 的提交接口只返回 `{"code":0,"info":"success"}`，
   * 不带 ID，这种情况要回退到「轮询提交列表认领最新那条」。
   */
  submissionId?: string;
  raw?: unknown;
}

export type SubmitEncoding = 'multipart' | 'form' | 'json';

/**
 * 上传源码前要不要转码。
 * `none` 原样上传文件字节（等价于浏览器上传文件），`utf8` 重新编码成 UTF-8。
 */
export type SubmitTranscode = 'none' | 'utf8';

/** OJ 客户端抽象：mock 与真实 HTTP 实现都遵循这个接口。 */
export interface OjClient {
  readonly label: string;
  /** 比赛列表。不区分比赛的 OJ 可以返回单个伪比赛，或返回空数组表示走扁平模式。 */
  listContests(): Promise<Contest[]>;
  /** 某场比赛下的题目。 */
  getContestProblems(contestId: string): Promise<ProblemSummary[]>;
  listProblems(): Promise<ProblemSummary[]>;
  getProblem(id: string): Promise<ProblemDetail>;
  loadContent(detail: ProblemDetail): Promise<ProblemContent>;
  submit(input: SubmitInput): Promise<SubmitResult>;
  /**
   * 拉取提交页并刮出隐藏字段（classId 之类）。
   * 没有配置提交页接口时返回空对象。
   */
  loadSubmitPage(problemId: string, contestId?: string): Promise<Record<string, string>>;
  /**
   * 查询单条提交。
   * 没有「单条查询接口」的 OJ 可以退回到扫描提交列表（contestId 用来定位）。
   */
  getSubmission(id: string, contestId?: string): Promise<Submission | undefined>;
  /** 提交记录列表。XDOJ 是按比赛维度查的。 */
  listSubmissions(contestId?: string): Promise<Submission[]>;

  /**
   * 可选：某次提交的**逐测试点**结果。
   * 拿不到 judgeId 时应当抛错（由界面显示成一行提示，而不是假装没有测试点）。
   */
  loadTestCaseRuns?(input: { submissionId: string; judgeId?: string }): Promise<TestCaseRun[]>;

  /** 可选：按配置的步骤序列预热某场比赛的会话状态。 */
  warmUpContest?(contestId: string): Promise<void>;

  /** 可选：换会话后重置预热标记。 */
  resetPrewarm?(): void;

  /** 可选：诊断用。直接打一个 URL，把结果压成一行，不抛异常。 */
  probe?(
    method: string,
    url: string,
    options?: {
      body?: string;
      contentType?: string;
      referer?: string;
      accept?: string;
      /** 从最终请求里摘掉这些头，用于二分定位。 */
      removeHeaders?: string[];
      /** 覆盖 / 追加请求头，优先级最高。 */
      extraHeaders?: Record<string, string>;
    },
  ): Promise<{
    status: number;
    ok: boolean;
    summary: string;
    bytes: number;
    sentHeaders: Record<string, string>;
  }>;

  /** 可选：按配置的步骤序列预热某场比赛的会话状态。 */
  warmUpContest?(contestId: string): Promise<void>;

  /** 可选：换会话后重置预热标记。 */
  resetPrewarm?(): void;

  /** 可选：诊断用。模拟浏览器「先开登录页再登录」的流程，返回新会话的 Cookie。 */
  tryBrowserLikeLogin?(): Promise<{ cookie: string; steps: string[] } | undefined>;

  /** 可选：按配置的步骤序列预热某场比赛的会话状态。 */
  warmUpContest?(contestId: string): Promise<void>;

  /** 可选：换会话后重置预热标记。 */
  resetPrewarm?(): void;

  /** 可选：诊断用。列出各接口实际会请求的 URL。 */
  diagnosticTargets?(
    contestId?: string,
    problemId?: string,
  ): Array<{
    label: string;
    method: string;
    url: string;
    body?: string;
    contentType?: string;
    referer?: string;
    accept?: string;
  }>;
}

export class OjError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OjError';
  }
}
