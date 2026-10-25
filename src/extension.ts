import * as vscode from 'vscode';
import { initLogger, log } from './logger';
import { XdojService } from './service';
import { ProblemTreeProvider, ProblemNode } from './views/problemTree';
import { SubmissionTreeProvider, SubmissionNode } from './views/submissionTree';
import { StatusBar } from './statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context.subscriptions);
  log.info(`XDOJ 扩展启动（扩展目录：${context.extensionUri.fsPath}）`);

  const service = new XdojService(context);
  context.subscriptions.push(service);

  const problemProvider = new ProblemTreeProvider({
    hasContests: () => service.hasContests(),
    getContests: () => service.getContests(),
    getProblems: () => service.getProblems(),
    loadContestProblems: (contest) => service.loadContestProblems(contest),
    onDidChangeProblems: service.onDidChangeProblems,
  });
  const submissionProvider = new SubmissionTreeProvider(service.submissions);

  const problemView = vscode.window.createTreeView('xdoj.problems', {
    treeDataProvider: problemProvider,
    showCollapseAll: false,
  });
  const submissionView = vscode.window.createTreeView('xdoj.submissions', {
    treeDataProvider: submissionProvider,
    showCollapseAll: false,
  });

  const statusBar = new StatusBar(service);
  context.subscriptions.push(problemProvider, submissionProvider, problemView, submissionView, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('xdoj.refreshProblems', () => service.refreshProblems()),
    vscode.commands.registerCommand('xdoj.openProblem', (arg?: unknown) =>
      service.openProblem(resolveProblemId(arg) ?? ''),
    ),
    vscode.commands.registerCommand('xdoj.openProblemById', () => service.openProblemById()),
    vscode.commands.registerCommand('xdoj.filterProblems', async () => {
      const value = await vscode.window.showInputBox({
        title: 'XDOJ: 过滤题目',
        prompt: '按题号、标题或标签过滤，留空则清除过滤',
        value: problemProvider.getFilter(),
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        problemProvider.setFilter(value);
      }
    }),
    vscode.commands.registerCommand('xdoj.submitFile', async (arg?: unknown) => {
      // 从编辑器标题栏 / 右键菜单触发时，参数是被点击文件的 Uri。
      if (arg instanceof vscode.Uri) {
        await focusDocument(arg);
      }
      await service.submitActiveFile();
    }),
    vscode.commands.registerCommand('xdoj.submitFileTo', async (arg?: unknown) => {
      await service.submitFileTo(resolveProblemId(arg));
    }),
    vscode.commands.registerCommand('xdoj.refreshSubmissions', () => service.refreshSubmissions()),
    vscode.commands.registerCommand('xdoj.openSubmission', (arg?: unknown) =>
      service.openSubmission(resolveSubmissionId(arg) ?? ''),
    ),
    vscode.commands.registerCommand('xdoj.clearSubmissions', () => service.clearSubmissions()),
    vscode.commands.registerCommand('xdoj.login', () => service.login()),
    vscode.commands.registerCommand('xdoj.logout', () => service.logout()),
    vscode.commands.registerCommand('xdoj.setPassword', () => service.setPassword()),
    vscode.commands.registerCommand('xdoj.clearPassword', () => service.clearPassword()),
    vscode.commands.registerCommand('xdoj.diagnostics', () => service.runDiagnostics()),
    vscode.commands.registerCommand('xdoj.showLogs', () => log.show()),
    vscode.commands.registerCommand('xdoj.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'xdoj'),
    ),
    vscode.commands.registerCommand('xdoj.copyProblemStatementUrl', async (arg?: unknown) => {
      const id = resolveProblemId(arg);
      if (!id) {
        return;
      }
      try {
        const detail = await service.getProblemDetailForCopy(id);
        await vscode.env.clipboard.writeText(detail);
        void vscode.window.showInformationMessage('XDOJ: 题面地址已复制。');
      } catch (error) {
        void vscode.window.showErrorMessage(
          `XDOJ: 获取题面地址失败 — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  // 没有站点地址就什么都做不了：先引导填，别让用户对着空侧栏猜。
  if (!service.getConfig().endpoint && !service.getConfig().useMockData) {
    void offerEndpointSetup();
  }

  // 先把登录会话准备好（真实 OJ 模式下），再拉题目列表。
  await service.bootstrap();

  // 还没登录就静默刷新只会刷出一堆 401 报错，侧栏的引导文案已经够清楚了。
  if (service.canReachOj() && service.getProblems().length === 0) {
    await service.refreshProblems({ silent: true });
  }
}

export function deactivate(): void {
  // 所有资源都挂在 context.subscriptions 上，由 VS Code 统一释放。
}

/**
 * 首次运行（或把 `xdoj.endpoint` 清空）时的引导。
 *
 * 地址没有默认值 —— 开源版本不该替用户假定一个 OJ；但也不能只是静默失败。
 */
async function offerEndpointSetup(): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    'XDOJ: 还没配置 OJ 站点根地址，扩展现在什么都拉不到。' +
      '请在设置里填 `xdoj.endpoint`，例如 http://your-oj.example/ 。',
    '打开设置',
    '先用样例数据看看',
  );
  if (action === '打开设置') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'xdoj.endpoint');
    return;
  }
  if (action === '先用样例数据看看') {
    // 写进用户设置（Global），重启后仍然有效，能先把界面摸一遍。
    await vscode.workspace
      .getConfiguration('xdoj')
      .update('useMockData', true, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      'XDOJ: 已切到内置样例数据。想连真实 OJ 时，把 xdoj.useMockData 关掉并填好 xdoj.endpoint。',
    );
  }
}

async function focusDocument(uri: vscode.Uri): Promise<void> {
  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
  if (visible) {
    await vscode.window.showTextDocument(visible.document, visible.viewColumn, false);
    return;
  }
  try {
    await vscode.window.showTextDocument(uri, { preview: false });
  } catch (error) {
    log.warn(`无法打开 ${uri.fsPath}`, error);
  }
}

/** 命令参数可能是题号字符串、ProblemNode，或 TreeItem 的 handle。 */
function resolveProblemId(arg: unknown): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg.trim() || undefined;
  }
  if (arg instanceof ProblemNode) {
    return arg.problem.id;
  }
  if (typeof arg === 'object') {
    const candidate = arg as { problem?: { id?: string }; id?: string };
    if (candidate.problem?.id) {
      return candidate.problem.id;
    }
    if (typeof candidate.id === 'string') {
      return candidate.id;
    }
  }
  return undefined;
}

function resolveSubmissionId(arg: unknown): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (typeof arg === 'string') {
    return arg.trim() || undefined;
  }
  if (arg instanceof SubmissionNode) {
    return arg.submission.id;
  }
  if (typeof arg === 'object') {
    const candidate = arg as { submission?: { id?: string }; id?: string };
    if (candidate.submission?.id) {
      return candidate.submission.id;
    }
    if (typeof candidate.id === 'string') {
      return candidate.id;
    }
  }
  return undefined;
}
