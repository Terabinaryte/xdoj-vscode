import * as vscode from 'vscode';
import { basename, extname, isAbsolute } from 'node:path';
import { MockOjClient } from './api/mockClient';
import { HttpOjClient } from './api/httpClient';
import {
  OjError,
  VERDICT_LABEL,
  isSettled,
  type Contest,
  type OjClient,
  type ProblemContent,
  type ProblemDetail,
  type ProblemSummary,
  type Submission,
} from './api/types';
import { CONFIG_SECTION, getConfig, type XdojConfig } from './config';
import { SessionManager } from './auth';
import { log } from './logger';
import { ProblemPanelManager } from './problemPanel';
import { SubmissionPanel } from './submissionPanel';
import { SubmissionStore } from './views/submissionStore';
import { fillTemplate, isAbsoluteUrl, resolveUrl } from './util/url';
import { readSourceSnapshot, type SourceSnapshot } from './util/sourceFile';
import { sanitizeFileName } from './api/statement';

/** 允许提交的文件后缀。 */
const CPP_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.cp', '.c']);

/**
 * 这个文档能不能当作「要提交的文件」。
 *
 * 未保存的文档先是 `untitled://`，`fsPath` 叫 `Untitled-1`（没有后缀），
 * 所以只能靠 languageId 认；它会在提交流程里被引导去「另存为」。
 */
function isSubmitCandidate(document: vscode.TextDocument): boolean {
  if (document.isUntitled) {
    return document.languageId === 'cpp' || document.languageId === 'c';
  }
  return CPP_EXTENSIONS.has(extname(document.uri.fsPath).toLowerCase());
}

/** 文件里写 `// @xdoj <题号>` 就能把这道题和当前文件绑定。 */
const DIRECTIVE_PATTERN = /@?xdoj\s*[:=#]?\s*([A-Za-z0-9_.-]+)/i;

/** 认领提交时允许的时间偏差（服务端与本地时钟可能不一致）。 */
const SUBMIT_MATCH_WINDOW_MS = 5 * 60_000;

/** 一次等待结果的提交。 */
interface SubmissionWatch {
  /** store 里的 key。没有远端 ID 时是本地生成的占位 id。 */
  localId: string;
  /** 远端提交 ID。提交接口不给 ID 时为空，靠轮询列表认领。 */
  remoteId?: string;
  problemId: string;
  contestId?: string;
  submittedAt: number;
}

export class XdojService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly problemEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeProblems = this.problemEmitter.event;

  readonly submissions = new SubmissionStore();
  readonly panels: ProblemPanelManager;
  /** 登录会话：账户密码登录、token/cookie 保存与自动续期。 */
  readonly session: SessionManager;

  private problems: ProblemSummary[] = [];
  private contests: Contest[] = [];
  /** 题号 → 题目 的索引。比赛模式下的题目是展开时才拉到的，拿到就登记进来。 */
  private readonly problemIndex = new Map<string, ProblemSummary>();
  private config: XdojConfig;
  private client: OjClient;
  private lastProblemId: string | undefined;
  /** 当前比赛。提交记录接口是按比赛查的，所以得记住一个。 */
  private currentContestId: string | undefined;
  private watching: SubmissionWatch[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  /** 每场比赛的 classId 缓存（从提交页刮到的）。 */
  private readonly classIdCache = new Map<string, string>();
  /** 已经弹过的编码告警，避免重复打扰。 */
  private readonly encodingWarnings = new Set<string>();
  /** 最近一次激活过的 C/C++ 编辑器，焦点跑到侧栏/题面时靠它兜底。 */
  private lastCppEditor: vscode.TextEditor | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.config = getConfig();
    this.session = new SessionManager(context.secrets, () => this.config);
    this.client = this.createClient();

    this.panels = new ProblemPanelManager(context, {
      openExternally: (detail, content) => this.openContentExternally(detail, content),
      reload: (detail) => this.reloadProblem(detail),
      submit: (problemId) => this.submitActiveFile(problemId),
    });

    this.disposables.push(
      this.panels,
      this.session,
      this.panels.onDidChangeActiveProblem((id) => {
        if (id) {
          this.lastProblemId = id;
        }
      }),
      this.submissions,
      // 换会话（重新登录 / 退出）后，之前预热出来的「当前比赛」状态就作废了。
      this.session.onDidChange(() => this.client.resetPrewarm?.()),
      // 记住最后看过的 cpp 文件：activeTextEditor 在焦点离开文本编辑器时会变 undefined，
      // 光靠它会让「明明开着文件」的提交报「没有打开文件」。
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isSubmitCandidate(editor.document)) {
          this.lastCppEditor = editor;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          log.info('检测到配置变化，重建 OJ 客户端');
          this.config = getConfig();
          this.client = this.createClient();
          void this.refreshProblems();
        }
      }),
    );
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 扩展激活后调用：先恢复上次的会话，如果没恢复成功、
   * 但地址/账户/密码都配好了，就静默登录一次。
   */
  async bootstrap(): Promise<void> {
    if (this.config.password) {
      // 明文密码只该存在于系统凭据库里；settings.json 常常会被提交进仓库。
      log.warn(
        'xdoj.password 是**明文**保存在设置里的。建议把它留空，改用命令「XDOJ: 设置密码」——' +
          '密码会存进 VS Code 的加密凭据库，不会出现在 settings.json 里。',
      );
    }
    if (this.config.useMockData) {
      log.info('当前使用内置样例数据，跳过登录');
      return;
    }
    if (!this.config.endpoint) {
      log.info('还没配置 xdoj.endpoint，跳过登录（设置里填上站点根地址即可）');
      return;
    }

    await this.session.restore();
    if (this.session.isLoggedIn) {
      return;
    }

    const missing = await this.session.missingCredentials();
    if (missing.length > 0) {
      log.info(`尚未配置完整的登录信息，缺少：${missing.join('、')}`);
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'XDOJ: 正在登录' },
        () => this.session.login(),
      );
    } catch (error) {
      // 启动阶段的登录失败不打断使用，用户可以用命令手动重试。
      log.warn('自动登录失败', error);
      void vscode.window
        .showWarningMessage(
          `XDOJ: 自动登录失败 — ${error instanceof Error ? error.message : String(error)}`,
          '重试登录',
          '打开设置',
        )
        .then((choice) => {
          if (choice === '重试登录') {
            void this.login();
          } else if (choice === '打开设置') {
            void vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
          }
        });
    }
  }

  // ---------------------------------------------------------------- 客户端

  private createClient(): OjClient {
    if (this.config.useMockData) {
      return new MockOjClient(this.context.extensionUri);
    }
    if (!this.config.endpoint) {
      log.warn('xdoj.endpoint 为空，真实请求会失败。请在设置里填写 OJ 站点地址。');
    }
    return new HttpOjClient(this.config, this.session);
  }

  get clientLabel(): string {
    return this.client.label;
  }

  get isMock(): boolean {
    return this.config.useMockData;
  }

  /** 现在发请求有没有意义：样例模式，或者已经登录成功。 */
  canReachOj(): boolean {
    // 没配地址时任何请求都发不出去，别拿它当「能连上」。
    return this.config.useMockData || (!!this.config.endpoint && this.session.isLoggedIn);
  }

  getConfig(): XdojConfig {
    return this.config;
  }

  // ---------------------------------------------------------------- 题目

  /** 这个 OJ 是不是按比赛组织题目。 */
  hasContests(): boolean {
    return this.config.endpoints.contests.trim().length > 0;
  }

  getContests(): Contest[] {
    return this.contests;
  }

  /**
   * 当前比赛。
   * 提交记录接口必须带 contestId，所以优先用最近打开过的题目所属比赛，
   * 没有就退回列表里的第一场比赛。
   */
  currentContest(): Contest | undefined {
    if (this.currentContestId) {
      const found = this.contests.find((c) => c.id === this.currentContestId);
      if (found) {
        return found;
      }
    }
    return this.contests[0];
  }

  getCurrentContestId(): string | undefined {
    return this.currentContest()?.id;
  }

  getProblems(): ProblemSummary[] {
    return this.problems;
  }

  findProblem(id: string): ProblemSummary | undefined {
    return this.problemIndex.get(id) ?? this.problems.find((p) => p.id === id);
  }

  problemTitle(id: string): string {
    return this.findProblem(id)?.title ?? `题目 ${id}`;
  }

  /** 懒加载某场比赛的题目，并登记进题号索引。 */
  async loadContestProblems(contest: Contest): Promise<ProblemSummary[]> {
    this.currentContestId ??= contest.id;
    if (contest.inlineProblems && contest.inlineProblems.length > 0) {
      this.rememberProblems(contest.inlineProblems);
      return contest.inlineProblems;
    }
    const problems = await this.client.getContestProblems(contest.id);
    this.rememberProblems(problems);
    return problems;
  }

  private rememberProblems(problems: ProblemSummary[]): void {
    for (const problem of problems) {
      this.problemIndex.set(problem.id, problem);
    }
  }

  async refreshProblems(options: { silent?: boolean } = {}): Promise<void> {
    const run = async () => {
      this.problemIndex.clear();
      if (this.hasContests()) {
        const contests = await this.client.listContests();
        this.contests = contests;
        this.problems = [];
        // 有些接口会把题目内联在比赛里，先一并收进索引。
        for (const contest of contests) {
          this.rememberProblems(contest.inlineProblems ?? []);
        }
        log.info(`比赛列表已更新：${contests.length} 个`);
      } else {
        const problems = await this.client.listProblems();
        this.problems = problems;
        this.contests = [];
        this.rememberProblems(problems);
        log.info(`题目列表已更新：${problems.length} 题`);
      }
      this.problemEmitter.fire();
    };

    try {
      if (options.silent) {
        await run();
      } else {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'XDOJ: 正在获取题目列表' },
          run,
        );
      }
    } catch (error) {
      this.problemEmitter.fire();
      await this.reportError('获取题目列表失败', error);
    }
  }

  /** 打开题面标签页。已经打开过的题会复用标签。 */
  async openProblem(id: string): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `XDOJ: 正在加载题目 ${id}` },
        async () => {
          const detail = await this.resolveDetail(id);
          const downloaded = await this.client.loadContent(detail);
          const content = await this.saveStatement(detail, downloaded);
          this.lastProblemId = detail.id;
          await this.panels.show(detail, content, this.config);
        },
      );
    } catch (error) {
      await this.reportError(`打开题目 ${id} 失败`, error);
    }
  }

  /**
   * 拼出题目详情。
   *
   * XDOJ 的题目详情接口还没确认，但比赛题目列表返回的字段（标题、限时、内存）
   * 其实够用了，所以 `xdoj.endpoints.problem` 留空时直接用列表里的信息。
   * 配了详情接口但又请求失败时，也退回列表信息，别让一道题打不开。
   */
  private async resolveDetail(id: string): Promise<ProblemDetail> {
    const summary = this.findProblem(id);
    let detail: ProblemDetail;

    const detailEndpoint = this.config.endpoints.problem.trim();
    if (detailEndpoint) {
      try {
        detail = await this.client.getProblem(id);
      } catch (error) {
        if (!summary) {
          throw error;
        }
        log.warn(`题目 ${id} 的详情接口失败，退回用列表里的信息`, error);
        detail = { ...summary };
      }
    } else {
      detail = summary
        ? { ...summary }
        : { id, title: `题目 ${id}`, tags: [] };
    }

    if (detail.contestId) {
      this.currentContestId = detail.contestId;
    }
    // 题面统一走附件下载接口。
    if (!detail.contentUrl) {
      const template = this.config.endpoints.statement.trim();
      if (template) {
        detail.contentUrl = fillTemplate(template, {
          id,
          account: this.config.account,
          userId: this.config.account,
          timestamp: String(Date.now()),
        });
      }
    }
    return detail;
  }

  /** 把题面文件落到 `xdoj.downloadDir`（默认 `<工作区>/problems/`）。 */
  private async saveStatement(
    detail: ProblemDetail,
    content: ProblemContent,
  ): Promise<ProblemContent> {
    if (content.kind === 'none') {
      return content;
    }
    const bytes = contentBytes(content);
    if (!bytes) {
      return content;
    }

    const dir = this.resolveDownloadDir();
    if (!dir) {
      return content;
    }

    const fallback = `${detail.id}.${content.extension ?? 'bin'}`;
    const filename = sanitizeFileName(
      content.filename ?? `${detail.id} ${detail.title}.${content.extension ?? 'bin'}`,
      fallback,
    );
    const target = vscode.Uri.joinPath(dir, filename);

    try {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(target, bytes);
      log.info(`题面已保存：${target.fsPath}（${bytes.byteLength} 字节）`);
      return { ...content, savedPath: target.fsPath, filename } as ProblemContent;
    } catch (error) {
      log.warn(`题面落盘失败（${target.fsPath}），继续只在标签页里渲染`, error);
      return content;
    }
  }

  /**
   * 解析下载目录。
   * 相对路径 → 工作区根目录；没开工作区 → 扩展的全局存储目录。
   */
  private resolveDownloadDir(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    let raw = this.config.downloadDir.trim();
    if (!raw) {
      return undefined;
    }

    raw = raw.replace(/\{workspaceFolder\}/gi, folder?.fsPath ?? '');
    if (/^~([/\\]|$)/.test(raw)) {
      raw = raw.replace(/^~/, process.env['HOME'] ?? process.env['USERPROFILE'] ?? '');
    }
    if (!raw.trim()) {
      return undefined;
    }
    if (isAbsolute(raw)) {
      return vscode.Uri.file(raw);
    }
    const relative = raw.replace(/^\.\//, '').replace(/^[/\\]+/, '');
    return folder
      ? vscode.Uri.joinPath(folder, relative)
      : vscode.Uri.joinPath(this.context.globalStorageUri, relative);
  }

  async openProblemById(): Promise<void> {
    const id = await vscode.window.showInputBox({
      title: 'XDOJ: 打开题目',
      prompt: '输入题号',
      placeHolder: '输入题号',
      ignoreFocusOut: true,
    });
    if (id?.trim()) {
      await this.openProblem(id.trim());
    }
  }

  /** 供「复制题面地址」命令使用：拿到补全后的绝对地址。 */
  async getProblemDetailForCopy(id: string): Promise<string> {
    const detail = await this.client.getProblem(id);
    if (!detail.contentUrl) {
      throw new Error('该题没有题面附件地址');
    }
    return resolveUrl(this.config.endpoint, detail.contentUrl);
  }

  private async reloadProblem(detail: ProblemDetail): Promise<void> {
    try {
      const fresh = await this.client.getProblem(detail.id);
      const content = await this.client.loadContent(fresh);
      this.panels.update(fresh, content);
    } catch (error) {
      await this.reportError(`重新加载题目 ${detail.id} 失败`, error);
    }
  }

  /**
   * 选择题目（QuickPick）。返回 undefined 表示用户取消。
   *
   * 比赛模式下是两步：先选比赛，再选该比赛下的题目。
   */
  async pickProblem(placeholder: string, preselect?: string): Promise<string | undefined> {
    if (this.hasContests()) {
      return this.pickProblemInContest(placeholder, preselect);
    }

    if (this.problems.length === 0) {
      await this.refreshProblems({ silent: true });
    }
    if (this.problems.length === 0) {
      void vscode.window.showWarningMessage('题目列表为空，请先检查 XDOJ 配置或点刷新。');
      return undefined;
    }

    const items = [...this.problems]
      .sort((a, b) => (a.id === preselect ? -1 : b.id === preselect ? 1 : 0))
      .map((p) => ({
        label: `${p.id}  ${p.title}`,
        description: [p.difficulty, ...p.tags.slice(0, 2)].filter(Boolean).join(' · '),
        problemId: p.id,
        picked: p.id === preselect,
      }));

    const choice = await vscode.window.showQuickPick(items, {
      title: 'XDOJ: 选择题目',
      placeHolder: placeholder,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    return choice?.problemId;
  }

  private async pickProblemInContest(
    placeholder: string,
    preselect?: string,
  ): Promise<string | undefined> {
    if (this.contests.length === 0) {
      await this.refreshProblems({ silent: true });
    }
    if (this.contests.length === 0) {
      void vscode.window.showWarningMessage('比赛列表为空，请先检查 XDOJ 配置或点刷新。');
      return undefined;
    }

    const contestChoice = await vscode.window.showQuickPick(
      [...this.contests].map((contest) => ({
        label: contest.title,
        description: [contest.statusString, `${contest.id}`].filter(Boolean).join(' · '),
        detail: contest.description,
        contest,
      })),
      {
        title: 'XDOJ: 选择比赛',
        placeHolder: placeholder,
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      },
    );
    if (!contestChoice) {
      return undefined;
    }

    let problems: ProblemSummary[];
    try {
      problems = await this.loadContestProblems(contestChoice.contest);
    } catch (error) {
      await this.reportError(`加载比赛「${contestChoice.contest.title}」的题目失败`, error);
      return undefined;
    }
    if (problems.length === 0) {
      void vscode.window.showWarningMessage(
        `XDOJ: 比赛「${contestChoice.contest.title}」下没有题目。`,
      );
      return undefined;
    }

    const problemChoice = await vscode.window.showQuickPick(
      [...problems]
        .sort((a, b) => (a.id === preselect ? -1 : b.id === preselect ? 1 : 0))
        .map((p) => ({
          label: `${p.id}  ${p.title}`,
          description: [p.difficulty, ...p.tags.slice(0, 2)].filter(Boolean).join(' · '),
          problemId: p.id,
          picked: p.id === preselect,
        })),
      {
        title: `XDOJ: ${contestChoice.contest.title}`,
        placeHolder: '选择题目',
        matchOnDescription: true,
        ignoreFocusOut: true,
      },
    );
    return problemChoice?.problemId;
  }

  // ---------------------------------------------------------------- 提交

  /** 侧栏 / 编辑器标题栏入口：提交当前激活的编辑器文件。 */
  async submitActiveFile(explicitProblemId?: string): Promise<void> {
    let editor = this.resolveTargetEditor();
    if (!editor) {
      void vscode.window.showWarningMessage(
        'XDOJ: 找不到可提交的 C/C++ 文件。请先打开一个 .cpp 文件并点一下它，再提交。',
      );
      return;
    }

    // 未保存的文档先拦下来 —— 它没有磁盘字节可读。
    if (editor.document.isUntitled) {
      if (!(await this.ensureSaved())) {
        return;
      }
      editor = this.resolveTargetEditor();
      if (!editor) {
        void vscode.window.showWarningMessage('XDOJ: 保存后找不到目标文件，已取消提交。');
        return;
      }
    }

    const document = editor.document;
    const extension = extname(document.uri.fsPath).toLowerCase();
    if (!CPP_EXTENSIONS.has(extension)) {
      void vscode.window.showWarningMessage(
        `XDOJ: 只支持提交 C/C++ 源文件，当前是 ${extension || '无后缀'}。`,
      );
      return;
    }

    const problemId = explicitProblemId ?? (await this.inferProblemId(document));
    if (!problemId) {
      void vscode.window.showWarningMessage('XDOJ: 没能确定要提交到哪道题，请手动选择。');
      await this.submitFileTo();
      return;
    }

    await this.doSave(document);

    const filename = basename(document.uri.fsPath);
    const source = await readSourceSnapshot(document);
    const code = source.text;
    const codeBytes = this.prepareSourceBytes(source, filename);
    const language = this.config.submitLanguage;
    const title = this.problemTitle(problemId);

    const contestId = this.findProblem(problemId)?.contestId ?? this.getCurrentContestId();
    const classId = await this.resolveClassId(problemId, contestId);

    let submissionId: string | undefined;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `XDOJ: 正在提交到 ${problemId} ${title}` },
        () => this.client.submit({ problemId, contestId, classId, language, code, codeBytes, filename }),
      );
      submissionId = result.submissionId;
    } catch (error) {
      await this.reportError('提交失败', error);
      return;
    }

    this.currentContestId = contestId ?? this.currentContestId;
    // 提交接口可能不给 ID，那就先放一条本地占位记录，轮询时再认领。
    const localId = submissionId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.submissions.upsert({
      id: localId,
      problemId,
      problemTitle: title,
      verdict: 'pending',
      language,
      createdAt: Date.now(),
      localOnly: true,
    });

    this.watchSubmission({
      localId,
      remoteId: submissionId,
      problemId,
      contestId,
      submittedAt: Date.now(),
    });

    void vscode.window.showInformationMessage(
      `XDOJ: 已提交 ${filename} → ${problemId} ${title}，正在评测…`,
    );
    // 把侧栏切到提交记录，让用户直接看到状态流转。
    await vscode.commands.executeCommand('xdoj.submissions.focus');
    await vscode.commands.executeCommand('setContext', 'xdoj.lastSubmissionId', submissionId);
  }

  /** 显式选择题目后提交。 */
  async submitFileTo(explicitProblemId?: string): Promise<void> {
    let problemId = explicitProblemId;
    if (!problemId) {
      const editor = this.resolveTargetEditor();
      const inferred = editor ? await this.inferProblemId(editor.document) : this.lastProblemId;
      problemId = await this.pickProblem('选择要提交到哪道题', inferred);
    }
    if (!problemId) {
      return;
    }
    await this.submitActiveFile(problemId);
  }

  /**
   * 拿 classId。
   *
   * XDOJ 的提交表单要求它，但它是服务端渲染进提交页 HTML 的隐藏字段，
   * 没有独立接口 —— 所以去页面里刮，并按比赛缓存。
   * 配置里显式填了 `xdoj.classId` 就以配置为准。
   */
  private async resolveClassId(problemId: string, contestId?: string): Promise<string | undefined> {
    if (this.config.classId) {
      return this.config.classId;
    }
    const cacheKey = contestId ?? '';
    const cached = this.classIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const fields = await this.client.loadSubmitPage(problemId, contestId);
      const scraped = fields['classId']?.trim();
      if (scraped) {
        log.info(`从提交页刮到 classId=${scraped}`);
        this.classIdCache.set(cacheKey, scraped);
        return scraped;
      }
      log.warn('提交页里没有 classId，本次提交不带该字段');
    } catch (error) {
      log.warn('刮取提交页失败，本次提交不带 classId', error);
    }
    return undefined;
  }

  /**
   * 决定提交哪个编辑器。
   *
   * `window.activeTextEditor` 只在**文本编辑器**有焦点时才不是 undefined ——
   * 点一下题面标签页、侧栏、输出面板，它就变成 undefined 了，于是出现
   * 「明明开着 cpp，点提交却说没打开文件」。所以这里按优先级退让：
   *
   * 1. 当前激活的编辑器（即使不是 cpp，也让后面报「只支持 C/C++」更准确）
   * 2. 最近激活过的 cpp 编辑器（只要它还开着）
   * 3. 任意一个可见的 cpp 编辑器
   */
  private resolveTargetEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) {
      return active;
    }
    const remembered = this.lastCppEditor;
    if (remembered && vscode.window.visibleTextEditors.includes(remembered)) {
      return remembered;
    }
    return vscode.window.visibleTextEditors.find((editor) => isSubmitCandidate(editor.document));
  }

  /**
   * 未保存的文档不能直接提交：磁盘上没有字节（编码保不住），
   * 文件名也不是 `.cpp`。这里给一次「另存为」的机会，存完继续提交。
   */
  private async ensureSaved(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      'XDOJ: 这个文件还没保存到磁盘，没法提交。' +
        '提交要读磁盘上的原始字节（这样 GB2312 这类编码才不会被改坏），文件名也得是 .cpp。',
      '另存为…',
      '取消',
    );
    if (choice !== '另存为…') {
      return false;
    }
    await vscode.commands.executeCommand('workbench.action.files.saveAs');
    const editor = this.resolveTargetEditor();
    if (!editor || editor.document.isUntitled) {
      void vscode.window.showInformationMessage('XDOJ: 文件仍未保存，已取消提交。');
      return false;
    }
    return true;
  }

  private async doSave(document: vscode.TextDocument): Promise<void> {
    if (!document.isDirty) {
      return;
    }
    const saved = await document.save();
    if (!saved) {
      log.warn(`文件 ${document.uri.fsPath} 保存失败，将按内存中的内容提交`);
    }
  }

  /**
   * 决定往上传哪份字节。
   *
   * 默认**原样上传磁盘字节**：文件是 GB2312 也不会被改成 UTF-8，
   * 和浏览器 `<input type="file">` 上传的效果一致。只有显式配置
   * `xdoj.submitTranscode: "utf8"` 时才重新编码。
   */
  private prepareSourceBytes(source: SourceSnapshot, filename: string): Uint8Array {
    if (this.config.submitTranscode === 'utf8') {
      if (source.lossy) {
        this.warnLossy(filename, source.encoding);
      }
      const bytes = new TextEncoder().encode(source.text);
      log.info(
        `提交源码 ${filename}：xdoj.submitTranscode=utf8，由 ${source.encoding} 重新编码为 UTF-8，` +
          `${bytes.byteLength} 字节`,
      );
      return bytes;
    }

    if (source.fromDisk) {
      log.info(
        `提交源码 ${filename}：原样上传磁盘字节，${source.bytes.byteLength} 字节，` +
          `编码 ${source.encoding}${source.nonUtf8 ? '（非 UTF-8）' : ''}`,
      );
      if (source.nonUtf8 && source.lossy) {
        // 字节是好的，只是 VS Code 用错编码解释它，界面上多半是乱码。
        // 这不影响评测，但不说清楚用户会以为插件传错了东西。
        this.warnOnce(
          `encoding:${filename}`,
          `XDOJ: ${filename} 不是 UTF-8 文件，编辑器里可能显示为乱码。` +
            '已按**原始字节**提交（不影响评测）；' +
            '用右下角的「通过编码重新打开」选 GB2312/GBK 即可正常查看。',
        );
      }
      return source.bytes;
    }

    // 走到这里说明拿不到磁盘字节（未命名文档，或保存失败）。
    if (source.lossy) {
      this.warnLossy(filename, source.encoding);
    }
    log.warn(
      `提交源码 ${filename}：拿不到磁盘字节（未保存或保存失败），` +
        `改用内存内容按 UTF-8 编码，${source.bytes.byteLength} 字节`,
    );
    return new TextEncoder().encode(source.text);
  }

  private warnLossy(filename: string, encoding: string): void {
    log.warn(
      `提交源码 ${filename}：按 ${encoding} 解码时出现替换字符（U+FFFD），源码内容可能已损坏`,
    );
    this.warnOnce(
      `lossy:${filename}`,
      `XDOJ: ${filename} 里有无法按 ${encoding} 解码的字节，提交内容可能已损坏。` +
        '请用右下角编码菜单「通过编码重新打开」（例如 GB2312/GBK）后再提交。',
    );
  }

  /** 同一类提示只弹一次，避免每次提交都糊用户一脸。 */
  private warnOnce(key: string, message: string): void {
    if (this.encodingWarnings.has(key)) {
      return;
    }
    this.encodingWarnings.add(key);
    void vscode.window.showWarningMessage(message);
  }

  /**
   * 推断当前文件属于哪道题，优先级：
   * 1. 当前聚焦的题面标签页
   * 2. 文件里写的 `// @xdoj <题号>` 指令
   * 3. 本次会话中最后打开的题目
   */
  private async inferProblemId(document: vscode.TextDocument): Promise<string | undefined> {
    const fromPanel = this.panels.activeId;
    if (fromPanel) {
      return fromPanel;
    }
    const fromDirective = findDirective(document.getText());
    if (fromDirective) {
      return fromDirective;
    }
    return this.lastProblemId;
  }

  // ---------------------------------------------------------------- 提交轮询

  private watchSubmission(watch: SubmissionWatch): void {
    this.watching = [...this.watching, watch];
    this.ensurePolling();
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.watching.length === 0) {
      return;
    }
    this.pollTimer = setInterval(() => void this.pollOnce(), this.config.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.watching.length === 0) {
      this.stopPolling();
      return;
    }

    const now = Date.now();
    const survivors: SubmissionWatch[] = [];

    for (const watch of this.watching) {
      if (now - watch.submittedAt > this.config.pollTimeoutMs) {
        const existing = this.submissions.find(watch.remoteId ?? watch.localId);
        if (existing && !isSettled(existing.verdict)) {
          this.submissions.upsert({
            ...existing,
            message: existing.message ?? '轮询超时，仍未拿到最终结果，可稍后手动刷新。',
          });
        }
        continue;
      }

      try {
        const submission = watch.remoteId
          ? await this.client.getSubmission(watch.remoteId, watch.contestId)
          : await this.adoptSubmission(watch);

        if (!submission) {
          survivors.push(watch);
          continue;
        }

        if (!watch.remoteId) {
          // 认领成功：把本地占位记录换成真实提交 ID。
          this.submissions.remove(watch.localId);
          watch.remoteId = submission.id;
        }
        this.submissions.upsert(submission);

        if (isSettled(submission.verdict)) {
          this.notifyVerdict(submission);
          continue;
        }
        survivors.push(watch);
      } catch (error) {
        log.warn(`轮询提交 ${watch.remoteId ?? watch.localId} 失败`, error);
        survivors.push(watch);
      }
    }

    this.watching = survivors;
    if (this.watching.length === 0) {
      this.stopPolling();
    }
  }

  /**
   * 提交接口不给 ID 时，去提交记录列表里认领最新的一条。
   *
   * XDOJ 的 submit.do 只回 `{"code":0,"info":"success"}`，所以只能靠
   * 「同一道题 + 提交时间在合理窗口内」来匹配。
   */
  private async adoptSubmission(watch: SubmissionWatch): Promise<Submission | undefined> {
    const list = await this.client.listSubmissions(watch.contestId);
    const found = list
      .filter((item) => item.problemId === watch.problemId)
      .filter((item) => (item.createdAt ?? 0) >= watch.submittedAt - SUBMIT_MATCH_WINDOW_MS)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

    if (found) {
      log.info(`认领到提交：题目 ${watch.problemId} → 提交 ${found.id}（${found.verdict}）`);
    }
    return found;
  }

  private notifyVerdict(submission: Submission): void {
    const label = VERDICT_LABEL[submission.verdict] ?? submission.verdict;
    const name = `${submission.problemId ?? ''} ${submission.problemTitle ?? ''}`.trim();
    const message = `XDOJ: ${name || '提交'} 评测完成 → ${label}`;
    if (submission.verdict === 'accepted') {
      void vscode.window.showInformationMessage(message);
    } else {
      void vscode.window.showWarningMessage(message, '查看详情').then((choice) => {
        if (choice === '查看详情') {
          void this.openSubmission(submission.id);
        }
      });
    }
  }

  // ---------------------------------------------------------------- 提交记录

  async refreshSubmissions(): Promise<void> {
    if (this.hasContests() && this.contests.length === 0) {
      await this.refreshProblems({ silent: true });
    }
    const contest = this.currentContest();
    if (this.hasContests() && !contest) {
      void vscode.window.showWarningMessage('XDOJ: 还没有比赛数据，无法查询提交记录。');
      return;
    }

    try {
      const list = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: contest ? `XDOJ: 正在获取「${contest.title}」的提交记录` : 'XDOJ: 正在获取提交记录',
        },
        () => this.client.listSubmissions(contest?.id),
      );
      this.submissions.replaceAll(list);
      // 正在轮询的记录不能被历史列表冲掉：还没认领到远端 ID 的占位记录尤其要保住。
      for (const watch of this.watching) {
        if (watch.remoteId) {
          continue; // 已经在 list 里了
        }
        const existing = this.submissions.find(watch.localId);
        if (existing) {
          this.submissions.upsert(existing);
        }
      }
    } catch (error) {
      await this.reportError('获取提交记录失败', error);
    }
  }

  /** 查询单条提交但不打开界面。没有单条接口时客户端会退回扫描列表。 */
  async fetchSubmission(id: string): Promise<Submission | undefined> {
    return this.client.getSubmission(id, this.getCurrentContestId());
  }

  clearSubmissions(): void {
    this.submissions.clear();
  }

  /**
   * 清掉按比赛缓存的元数据（目前是 classId）。
   * 换账号或重新登录后必须清，否则会拿着上一个身份的班级编号去提交。
   */
  clearCachedMetadata(): void {
    this.classIdCache.clear();
  }

  async openSubmission(id: string): Promise<void> {
    const cached = this.submissions.find(id);
    let submission = cached;
    try {
      const fresh = await this.client.getSubmission(id, this.getCurrentContestId());
      if (fresh) {
        this.submissions.upsert(fresh);
        submission = fresh;
      }
    } catch (error) {
      log.warn(`刷新提交 ${id} 详情失败，改用本地缓存展示`, error);
    }
    if (!submission) {
      void vscode.window.showWarningMessage(`XDOJ: 找不到提交 ${id} 的记录。`);
      return;
    }
    // 题面已经占了某一栏就开在那里，别每看一条提交就多一栏。
    const client = this.client;
    const loadRuns = client.loadTestCaseRuns
      ? () => client.loadTestCaseRuns!({ submissionId: submission.id, judgeId: submission.judgeId })
      : undefined;
    SubmissionPanel.show(submission, { column: this.panels.occupiedColumn(), loadRuns });
  }

  // ---------------------------------------------------------------- 诊断

  /**
   * 逐个接口探活，把真实 URL、状态码和服务端响应摘要打出来。
   *
   * 有些失败（尤其是 5xx）光看界面上的「HTTP 500」定位不了，
   * 这里会把服务端的响应体也带出来，并且顺手做几个对照实验。
   */
  async runDiagnostics(): Promise<void> {
    const lines: string[] = [];
    const add = (line = '') => lines.push(line);

    add('===== XDOJ 诊断报告 =====');
    add(`时间         ${new Date().toLocaleString()}`);
    add(`模式         ${this.isMock ? '内置样例数据' : '真实 OJ'}`);
    add(`地址         ${this.config.endpoint || '(未配置)'}`);
    add(`账户         ${this.config.account || '(未配置)'}`);
    add(`登录状态     ${this.session.isLoggedIn ? '已登录' : '未登录'}`);
    add(`会话 Cookie  ${this.session.current?.cookies.length ?? 0} 个`);
    add(`额外 Cookie  ${Object.keys(this.config.extraCookies).join(', ') || '(无)'}`);
    add(`公共 query   ${JSON.stringify(this.config.commonQueryParams)}`);
    add(`Referer      ${JSON.stringify(this.config.referers)}`);
    add('');

    if (!this.client.diagnosticTargets || !this.client.probe) {
      add('当前客户端不支持诊断（样例数据模式）。');
    } else {
      if (this.contests.length === 0) {
        await this.refreshProblems({ silent: true });
      }
      const contestId = this.getCurrentContestId();
      const known = [...this.problemIndex.values()];
      const problemId = known.find((p) => p.contestId === contestId)?.id ?? known[0]?.id;
      add(`比赛         ${contestId ?? '(未知)'}`);
      add(`题目         ${problemId ?? '(未知，比赛题目接口没成功过所以拿不到)'}`);
      add('');

      const targets = this.client.diagnosticTargets(contestId, problemId);
      let bisected = false;

      for (const target of targets) {
        const options = {
          body: target.body,
          contentType: target.contentType,
          referer: target.referer,
          accept: target.accept,
        };
        const result = await this.client.probe(target.method, target.url, options);

        add(`[${result.ok ? 'OK  ' : 'FAIL'}] ${target.label}  (${target.method})`);
        add(`       ${target.url}`);
        if (target.body) {
          add(`       body: ${target.body}`);
        }
        add(`       → HTTP ${result.status}${result.summary ? `  ${result.summary}` : ''}`);
        add(`       curl: ${toCurl(target.method, target.url, result.sentHeaders, target.body)}`);
        add('');

        // 对第一个失败的目标做二分：逐个摘掉请求头，看哪一项才是让服务端炸的原因。
        if (!result.ok && !bisected) {
          bisected = true;
          add('       —— 二分定位（逐个摘掉请求头重试）——');
          for (const variant of buildHeaderVariants(result.sentHeaders)) {
            const attempt = await this.client.probe(target.method, target.url, {
              ...options,
              removeHeaders: variant.removeHeaders,
              extraHeaders: variant.extraHeaders,
            });
            const note = variant.note ? `   ${variant.note}` : '';
            add(`       [${attempt.ok ? 'OK  ' : 'FAIL'}] ${variant.label}${note}`);
          }
          add('');

          // 换会话实验：如果问题出在扩展登录产生的会话上，这个实验能直接指出来。
          if (this.client.tryBrowserLikeLogin) {
            add('       —— 换会话实验：模拟浏览器「先打开登录页再登录」——');
            const alt = await this.client.tryBrowserLikeLogin();
            if (alt) {
              for (const step of alt.steps) {
                add(`       ${step}`);
              }
              if (alt.cookie) {
                const attempt = await this.client.probe(target.method, target.url, {
                  ...options,
                  extraHeaders: { Cookie: alt.cookie },
                });
                add(
                  `       [${attempt.ok ? 'OK  ' : 'FAIL'}] 用这个新会话重试 → HTTP ${attempt.status}` +
                    (attempt.summary ? `  ${attempt.summary}` : ''),
                );
                if (attempt.ok) {
                  add('       ⇒ 结论：问题出在扩展的登录会话上，不是请求头。');
                }
              } else {
                add('       （没拿到 Cookie，跳过）');
              }
            }
            add('');
          }
        }
      }
    }

    const report = lines.join('\n');
    log.info(report);
    log.show();
    await vscode.env.clipboard.writeText(report);
    void vscode.window
      .showInformationMessage('XDOJ: 诊断完成，报告已写入「输出 → XDOJ」并复制到剪贴板。', '知道了')
      .then(() => undefined);
  }

  // ---------------------------------------------------------------- 登录与凭据

  /** 用当前配置的地址 + 账户 + 密码登录一次（忽略已有会话）。 */
  async login(): Promise<void> {
    try {
      const missing = await this.session.missingCredentials();
      if (missing.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          `XDOJ: 登录信息不完整，还缺 ${missing.join('、')}。`,
          '打开设置',
        );
        if (choice === '打开设置') {
          await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
        }
        return;
      }

      const session = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'XDOJ: 正在登录' },
        () => this.session.login(true),
      );
      void vscode.window.showInformationMessage(
        `XDOJ: 已登录${session.account ? `（${session.account}）` : ''}，方式：${
          session.token ? 'token' : 'cookie'
        }。`,
      );
      // 换了会话就可能换了身份，缓存里的 classId 不能再信。
      this.clearCachedMetadata();
      // 登录后立刻刷新，之前因未登录而失败的请求现在应该能过了。
      await this.refreshProblems();
    } catch (error) {
      await this.reportError('登录失败', error);
    }
  }

  async logout(): Promise<void> {
    this.clearCachedMetadata();
    await this.session.logout();
    void vscode.window.showInformationMessage('XDOJ: 已退出登录（配置里的账户密码仍然保留）。');
  }

  /**
   * 设置密码。优先写进 VS Code 的加密凭据库；
   * 如果 settings 里已经填了 `xdoj.password`，提示它优先级更高。
   */
  async setPassword(): Promise<void> {
    if (this.config.password) {
      const choice = await vscode.window.showWarningMessage(
        'XDOJ: settings.json 里的 xdoj.password 已经填了内容，它的优先级高于这里保存的密码。',
        '仍要保存',
        '清掉设置项',
      );
      if (choice === '清掉设置项') {
        await vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .update('password', undefined, vscode.ConfigurationTarget.Global);
        return;
      }
      if (choice !== '仍要保存') {
        return;
      }
    }

    const password = await vscode.window.showInputBox({
      title: 'XDOJ: 设置密码',
      prompt: '输入 OJ 账户的密码（加密保存，不会出现在 settings.json 里）',
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      return;
    }
    await this.session.storePassword(password);
    void vscode.window.showInformationMessage(
      password ? 'XDOJ: 密码已加密保存。' : 'XDOJ: 已清除保存的密码。',
    );
  }

  async clearPassword(): Promise<void> {
    await this.session.clearPassword();
    void vscode.window.showInformationMessage('XDOJ: 已清除保存的密码。');
  }

  // ---------------------------------------------------------------- 其它

  /** docx 这类无法在线预览的附件：落地到全局存储目录再用系统程序打开。 */
  private async openContentExternally(detail: ProblemDetail, content: ProblemContent): Promise<void> {
    try {
      // 已经按 xdoj.downloadDir 落过盘了，直接打开那份，别再写一遍。
      const saved = content.kind !== 'none' ? content.savedPath : undefined;
      if (saved) {
        await vscode.env.openExternal(vscode.Uri.file(saved));
        return;
      }

      let bytes: Uint8Array | undefined;
      if (content.kind === 'docx' || content.kind === 'pdf') {
        bytes = content.data;
      }
      if (!bytes) {
        if (detail.contentUrl && isAbsoluteUrl(detail.contentUrl)) {
          await vscode.env.openExternal(vscode.Uri.parse(detail.contentUrl));
          return;
        }
        void vscode.window.showWarningMessage('XDOJ: 该题面没有可下载的附件。');
        return;
      }

      const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'statements');
      await vscode.workspace.fs.createDirectory(dir);
      const name = sanitizeFileName(
        `${detail.id}-${detail.title}${content.kind === 'pdf' ? '.pdf' : '.docx'}`,
        `${detail.id}.${content.kind === 'pdf' ? 'pdf' : 'docx'}`,
      );
      const target = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(target, bytes);
      log.info(`题面已保存到 ${target.fsPath}`);
      await vscode.env.openExternal(target);
    } catch (error) {
      await this.reportError('打开题面附件失败', error);
    }
  }

  private async reportError(prefix: string, error: unknown): Promise<void> {
    const message = error instanceof OjError ? error.message : error instanceof Error ? error.message : String(error);
    log.error(`${prefix}：${message}`, error);
    const choice = await vscode.window.showErrorMessage(`XDOJ: ${prefix} — ${message}`, '显示日志', '打开设置');
    if (choice === '显示日志') {
      log.show();
    } else if (choice === '打开设置') {
      await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
    }
  }

  dispose(): void {
    this.stopPolling();
    this.problemEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function findDirective(text: string): string | undefined {
  // 只看文件开头 2KB，避免把正文里的 "xdoj" 误当成绑定指令。
  const head = text.slice(0, 2048);
  const match = DIRECTIVE_PATTERN.exec(head);
  if (!match) {
    return undefined;
  }
  const value = match[1]?.trim();
  return value ? value : undefined;
}


/** 取出题面的原始字节；文本类也要，落盘时用原字节避免二次编码。 */
function contentBytes(content: ProblemContent): Uint8Array | undefined {
  switch (content.kind) {
    case 'pdf':
    case 'txt':
    case 'html':
      return content.data;
    case 'docx':
    case 'binary':
      return content.data;
    default:
      return undefined;
  }
}

/** 拼一条可以直接粘贴到终端复现的 curl。注意它包含真实 Cookie。 */
function toCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): string {
  const parts = [`curl -i -X ${method} '${url}'`];
  for (const [name, value] of Object.entries(headers)) {
    parts.push(`-H '${name}: ${value.replace(/'/g, "'\\''")}'`);
  }
  if (body) {
    parts.push(`--data '${body}'`);
  }
  return parts.join(' ');
}

interface HeaderVariant {
  label: string;
  note?: string;
  removeHeaders?: string[];
  extraHeaders?: Record<string, string>;
}

/**
 * 生成一组「逐个摘掉某项」的对照请求。
 *
 * 目的是把「扩展发的请求」和「curl 里能跑通的请求」之间的差异一项项消掉，
 * 从而定位到服务端到底是被哪个头惹毛的。
 */
function buildHeaderVariants(sentHeaders: Record<string, string>): HeaderVariant[] {
  const variants: HeaderVariant[] = [
    { label: '完整请求（当前）' },
    { label: '摘掉 Cookie', removeHeaders: ['Cookie'], note: '（用于确认是不是会话相关）' },
    { label: '摘掉 Accept-Language', removeHeaders: ['Accept-Language'] },
    { label: '摘掉 X-Requested-With', removeHeaders: ['X-Requested-With'] },
    { label: '摘掉 User-Agent', removeHeaders: ['User-Agent'] },
    { label: '摘掉 Referer', removeHeaders: ['Referer'] },
  ];

  // Cookie 顺序是有实证的差异点：浏览器/curl 都是 JSESSIONID 在前。
  const cookie = sentHeaders['Cookie'] ?? sentHeaders['cookie'];
  if (cookie && cookie.includes(';')) {
    const reversed = cookie
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .reverse()
      .join('; ');
    if (reversed !== cookie.trim()) {
      variants.push({
        label: 'Cookie 顺序反过来',
        extraHeaders: { Cookie: reversed },
        note: '（验证服务端是不是在用 cookies[0] 取 session id）',
      });
    }
  }

  return variants;
}
