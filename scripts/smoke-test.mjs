// 冒烟测试：用一套最小化的 vscode API 桩，把 out/ 里编译出来的真实扩展代码跑一遍。
//
// 为什么值得这么做：扩展代码只有在 Extension Host 里才会被 require，很容易出现
// 「编译通过但一激活就炸」的情况（拼错命令名、忘注册 provider、模板字符串报错）。
// 这里不依赖图形界面，也不动用户的桌面，就能覆盖激活、题目加载、题面 HTML 生成这几条主路径。
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------- 断言工具

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

// ----------------------------------------------------------------- vscode 桩

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(scheme, fsPath) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  static file(p) {
    return new Uri('file', p);
  }
  static parse(value) {
    const text = String(value);
    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
    return match ? new Uri(match[1], match[2]) : new Uri('file', text);
  }
  static joinPath(base, ...parts) {
    const root = String(base.fsPath).replace(/[/\\]+$/, '');
    return new Uri(base.scheme, [root, ...parts].join('/'));
  }
  toString() {
    return `${this.scheme}://${this.fsPath}`;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(v) {
    this.value += v;
    return this;
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const captured = {
  commands: new Map(),
  panels: [],
  messages: [],
  statusBar: [],
  output: [],
  infoMessages: [],
  errorMessages: [],
  openedExternal: [],
  clipboard: [],
  treeViews: [],
  notificationHandlers: [],
};

function createOutputChannel(name, options) {
  const record = { name, options, lines: [] };
  captured.output.push(record);
  const write = (level) => (message) => record.lines.push(`[${level}] ${message}`);
  return {
    name,
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    debug: write('debug'),
    trace: write('trace'),
    appendLine: (line) => record.lines.push(line),
    append: (line) => record.lines.push(line),
    show: () => {},
    hide: () => {},
    clear: () => {},
    replace: () => {},
    dispose: () => {},
    logLevel: 1,
    onDidChangeLogLevel: new EventEmitter().event,
  };
}

function createWebviewPanel(_viewType, title, column, _options) {
  const disposers = [];
  // ViewColumn.Active / Beside 是负数哨兵值，真实 VS Code 会解析成具体栏号；
  // 桩里统一当成「第 2 栏」，这样测试才能看出「复用同一栏」。
  const initialColumn = typeof column === 'number' && column > 0 ? column : 2;
  const panel = {
    title,
    viewColumn: initialColumn,
    active: true,
    visible: true,
    webview: {
      html: '',
      cspSource: 'vscode-webview://test-csp',
      options: {},
      asWebviewUri: (uri) => new Uri('https://test-cdn.vscode-cdn.net', uri.fsPath),
      onDidReceiveMessage: (handler) => {
        panel._messageHandler = handler;
        return { dispose: () => {} };
      },
      postMessage: async (message) => {
        captured.messages.push(message);
        return true;
      },
      onDidChangeHtml: () => ({ dispose: () => {} }),
      receiveMessage: async (message) => panel._messageHandler?.(message),
    },
    revealCalls: [],
    reveal: (viewColumn, preserveFocus) => {
      panel.revealCalls.push({ viewColumn, preserveFocus });
      if (typeof viewColumn === 'number' && viewColumn > 0) {
        panel.viewColumn = viewColumn;
      }
    },
    dispose: () => {
      for (const d of disposers) {
        d.dispose();
      }
      panel._disposed = true;
    },
    onDidDispose: (handler) => {
      // 真实 VS Code 在 dispose 时会触发 onDidDispose，桩里也得这样，
      // 否则扩展内部的标签页登记表不会清掉。
      disposers.push({ dispose: () => handler() });
      panel._disposeHandler = handler;
      return { dispose: () => {} };
    },
    onDidChangeViewState: () => ({ dispose: () => {} }),
    iconPath: undefined,
  };
  captured.panels.push(panel);
  return panel;
}

const configValues = {};

function createConfigSection(section) {
  return {
    get(key, fallback) {
      const full = section ? `${section}.${key}` : key;
      return full in configValues ? configValues[full] : fallback;
    },
    has: (key) => `${section}.${key}` in configValues,
    inspect: () => undefined,
    update: async (key, value) => {
      configValues[`${section}.${key}`] = value;
    },
  };
}

const configChangeEmitter = new EventEmitter();
const tabChangeEmitter = new EventEmitter();
const activeEditorEmitter = new EventEmitter();
captured.tabGroupsEmitter = tabChangeEmitter;

const vscodeStub = {
  EventEmitter,
  Uri,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ThemeColor2: undefined,
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel,
    createWebviewPanel,
    createTreeView: (id, options) => {
      const view = { id, options, visible: true, dispose: () => {}, reveal: async () => {}, onDidChangeVisibility: new EventEmitter().event };
      captured.treeViews.push(view);
      return view;
    },
    createStatusBarItem: (alignment, priority) => {
      const item = {
        alignment,
        priority,
        text: '',
        tooltip: undefined,
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      };
      captured.statusBar.push(item);
      return item;
    },
    showInformationMessage: async (message, ...items) => {
      captured.infoMessages.push({ message, items });
      return undefined;
    },
    showWarningMessage: async (message, ...items) => {
      captured.errorMessages.push({ level: 'warn', message, items });
      return undefined;
    },
    showErrorMessage: async (message, ...items) => {
      captured.errorMessages.push({ level: 'error', message, items });
      return undefined;
    },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async (doc) => ({ document: doc }),
    withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
    onDidChangeActiveTextEditor: activeEditorEmitter.event,
    tabGroups: { onDidChangeTabs: tabChangeEmitter.event, all: [], activeTabGroup: undefined },
    registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
  },
  workspace: {
    getConfiguration: (section) => createConfigSection(section),
    onDidChangeConfiguration: configChangeEmitter.event,
    fs: {
      createDirectory: async () => {},
      writeFile: async () => {},
      readFile: async (uri) => new Uint8Array(await readFile(uri.fsPath)),
    },
    openTextDocument: async (uri) => ({ uri, getText: () => '' }),
    workspaceFolders: [],
    onDidSaveTextDocument: new EventEmitter().event,
  },
  commands: {
    registerCommand: (name, handler) => {
      captured.commands.set(name, handler);
      return { dispose: () => captured.commands.delete(name) };
    },
    executeCommand: async (name, ...args) => {
      const handler = captured.commands.get(name);
      if (handler) {
        return handler(...args);
      }
      return undefined;
    },
    getCommands: async () => [...captured.commands.keys()],
  },
  env: {
    openExternal: async (uri) => {
      captured.openedExternal.push(uri.toString());
      return true;
    },
    clipboard: {
      writeText: async (value) => {
        captured.clipboard.push(value);
      },
      readText: async () => '',
    },
    appName: 'Test',
    language: 'zh-cn',
    machineId: 'test',
    uriScheme: 'vscode',
  },
  languages: {
    createDiagnosticCollection: () => ({ dispose: () => {} }),
  },
  l10n: { t: (message) => message },
  version: '1.95.0-test',
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ----------------------------------------------------------------- 准备上下文

const storageDir = await mkdtemp(join(tmpdir(), 'xdoj-smoke-'));

const secrets = new Map();
const context = {
  subscriptions: [],
  extensionUri: Uri.file(projectRoot),
  globalStorageUri: Uri.file(storageDir),
  storageUri: Uri.file(storageDir),
  secrets: {
    get: async (key) => secrets.get(key),
    store: async (key, value) => {
      secrets.set(key, value);
    },
    delete: async (key) => {
      secrets.delete(key);
    },
    onDidChange: new EventEmitter().event,
  },
  extensionPath: projectRoot,
  extensionMode: 2,
  globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
  workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
  asAbsolutePath: (p) => join(projectRoot, p),
};

// ----------------------------------------------------------------- 开跑

// --------------------------------------------------------------- 抓包 fixtures
// 放在最前面，避免后面的用例不小心引用到还没初始化的 const（TDZ）。

/** 抓包拿到的真实响应，原样贴进来。 */
const XDOJ_CONTEST_LIST_RESPONSE = {
  totalCount: 1,
  totalpages: 1,
  page: 1,
  data: [
    {
      active: true,
      classes: [],
      creatorId: 'fixture-teacher',
      description: '示例比赛说明',
      endTime: '2026-01-12 23:59:00',
      id: 'fixture-contest',
      judging: true,
      languages: [
        {
          compileCmdline: 'gcc.exe {srcfile} -lstdc++  -std=c++17 -o {basename}.exe',
          id: 2,
          name: 'GNU C/C++',
        },
      ],
      maxOutputLines: 0,
      maxOutputSize: 256,
      penaltyTime: 0,
      problems: [],
      running: true,
      showRankList: true,
      startTime: '2026-01-05 14:00:00',
      started: true,
      status: 1,
      statusString: 'Ready',
      timeBeforeStopJudge: 0,
      title: '示例比赛（进行中）',
      type: 0,
    },
  ],
};

/** 真实抓到的 Tomcat 500 错误页（XDOJ 的 contest/problems.do 就是这个）。 */
const TOMCAT_500_HTML =
  '<!doctype html><html lang="zh"><head><title>HTTP状态 500 - 内部服务器错误</title>' +
  '<style type="text/css">body {font-family:Tahoma,Arial,sans-serif;} h1 {font-size:22px;}</style>' +
  '</head><body><h1>HTTP状态 500 - 内部服务器错误</h1><hr class="line" />' +
  '<p><b>类型</b> 异常报告</p>' +
  '<p><b>消息</b> Request processing failed; nested exception is java.lang.ClassCastException</p>' +
  '<p><b>描述</b> 服务器遇到一个意外的情况，阻止它完成请求。</p>' +
  '<p><b>例外情况</b></p><pre>org.springframework.web.util.NestedServletException: Request processing failed; nested exception is java.lang.ClassCastException\n' +
  '\torg.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:982)\n' +
  '</pre><p><b>根本原因。</b></p><pre>java.lang.ClassCastException\n</pre>' +
  '<p><b>):注意</b> 主要问题的全部 stack 信息可以在 server logs 里查看</p>' +
  '<hr class="line" /><h3>Apache Tomcat/8.5.97</h3></body></html>';

/** 抓包拿到的比赛题目响应（截取前两条，字段保持原样）。 */
const XDOJ_CONTEST_PROBLEMS_RESPONSE = {
  totalCount: 7,
  totalpages: 1,
  page: 1,
  data: [
    {
      acceptSubmit: 37059,
      category: 1,
      categoryName: '基本计算',
      creatorId: 'fixture-teacher',
      difficulty: 1,
      id: 'fixture-problem-a',
      ignoreCase: false,
      ignoreEmptyLine: false,
      ignoreLineLeadingAndTailingSpace: false,
      mainProgram: [],
      mainProgramName: '',
      memoryLimit: 100,
      orderId: 0,
      points: 0,
      reserveOneSpaceBetweenData: false,
      solutionType: 0,
      tags: [{ id: 'fixture-tag', name: '基本计算' }],
      text: [],
      textType: '',
      timeLimit: 1,
      title: '计算球体重量',
      totalSubmit: 102150,
      visibleForAll: false,
      userAcceptCount: 1,
    },
    {
      acceptSubmit: 36369,
      category: 1,
      categoryName: '基本计算',
      creatorId: 'fixture-teacher',
      difficulty: 1,
      id: 'fixture-problem-b',
      memoryLimit: 100,
      orderId: 1,
      points: 0,
      tags: [{ id: 'fixture-tag', name: '基本计算' }],
      text: [],
      textType: '',
      timeLimit: 1,
      title: '温度转换',
      totalSubmit: 77691,
      visibleForAll: false,
      userAcceptCount: 0,
    },
  ],
};

console.log('\nXDOJ 扩展冒烟测试\n');

const originalLog = console.log;
console.log = () => {};
let extensionModule;
try {
  extensionModule = require(join(projectRoot, 'out', 'extension.js'));
} finally {
  console.log = originalLog;
}

await testAsync('extension.js 可加载并导出 activate', async () => {
  assert.equal(typeof extensionModule.activate, 'function', 'activate 应为函数');
  assert.equal(typeof extensionModule.deactivate, 'function', 'deactivate 应为函数');
});

// 默认走内置样例数据；轮询间隔调大，避免定时器干扰手工驱动的轮询。
configValues['xdoj.useMockData'] = true;
configValues['xdoj.pollIntervalMs'] = 60000;

await testAsync('activate() 在样例数据下正常完成', async () => {
  await extensionModule.activate(context);
});

test('注册了 package.json 里声明的全部命令', () => {
  const declared = JSON.parse(readFileSyncUtf8(join(projectRoot, 'package.json'))).contributes.commands.map(
    (c) => c.command,
  );
  const missing = declared.filter((name) => !captured.commands.has(name));
  assert.deepEqual(missing, [], `未注册的命令: ${missing.join(', ')}`);
});

test('创建了两个侧栏视图', () => {
  const ids = captured.treeViews.map((v) => v.id).sort();
  assert.deepEqual(ids, ['xdoj.problems', 'xdoj.submissions']);
});

test('输出通道拿到了启动日志', () => {
  const lines = captured.output.flatMap((c) => c.lines);
  assert.ok(lines.some((l) => l.includes('XDOJ 扩展启动')), `实际日志: ${lines.join(' | ')}`);
});

/**
 * 打开题目并模拟 webview 发 ready —— 扩展侧是收到 ready 之后才推内容的。
 * 返回这次新产生的内容消息。
 */
async function openProblemAndCollect(service, id) {
  const panelBefore = captured.panels.length;
  const messageBefore = captured.messages.length;
  const errorsBefore = captured.errorMessages.length;
  await service.openProblem(id);
  // openProblem 内部把异常转成了错误提示。不抛出来的话，面板会复用上一次的内容，
  // 断言就会在完全错误的地方失败（这个坑踩过两次了）。
  const swallowed = captured.errorMessages.slice(errorsBefore);
  if (swallowed.length > 0) {
    throw new Error(`openProblem 报错：${swallowed.map((e) => e.message).join(' / ')}`);
  }
  const panel = captured.panels[captured.panels.length - 1];
  assert.ok(panel, 'openProblem 没有产出面板');
  // 同一道题只开一个标签，后面几次是复用；复用也会重新赋值 html 并重推内容，
  // 所以这里无条件发 ready。
  await panel.webview.receiveMessage({ type: 'ready' });
  return {
    panel,
    created: captured.panels.length > panelBefore,
    messages: captured.messages.slice(messageBefore),
    content: captured.messages.slice(messageBefore).find((m) => m.kind),
  };
}

function makeTreeProvider(service) {
  const { ProblemTreeProvider } = require(join(projectRoot, 'out', 'views', 'problemTree.js'));
  return new ProblemTreeProvider({
    hasContests: () => service.hasContests(),
    getContests: () => service.getContests(),
    getProblems: () => service.getProblems(),
    loadContestProblems: (contest) => service.loadContestProblems(contest),
    onDidChangeProblems: service.onDidChangeProblems,
  });
}

await testAsync('侧栏是「比赛 → 题目」两级树，题目懒加载', async () => {
  const service = findService();
  const provider = makeTreeProvider(service);

  const roots = await provider.getChildren();
  assert.equal(roots.length, 3, `样例数据应有 3 场比赛，实际 ${roots.length}`);

  const items = roots.map((node) => provider.getTreeItem(node));
  // 正在进行的比赛排最前
  assert.equal(items[0].label, '示例比赛（进行中）', `第一场应是进行中的，实际 ${items[0].label}`);
  assert.equal(items[0].contextValue, 'xdoj.contest');
  assert.equal(items[0].collapsibleState, 1, '比赛节点应当是可折叠的');
  assert.match(String(items[0].description), /Ready/);
  assert.match(String(items[0].description), /2 题/, `描述里应带题目数，实际 ${items[0].description}`);

  // 展开第一场，懒加载出它的题目
  const children = await provider.getChildren(roots[0]);
  assert.equal(children.length, 2, `示例比赛（进行中）应有 2 题，实际 ${children.length}`);
  const problemItem = provider.getTreeItem(children[0]);
  assert.ok(String(problemItem.label).includes('sample-problem-a'), `实际 ${problemItem.label}`);
  assert.equal(problemItem.contextValue, 'xdoj.problem');

  // 再点一次应当走缓存，不会重复请求（样例客户端计数无法直接看，这里验证结果稳定）
  const again = await provider.getChildren(roots[0]);
  assert.equal(again.length, 2);
});

await testAsync('过滤在比赛层级生效，且空结果给出提示', async () => {
  const service = findService();
  const provider = makeTreeProvider(service);

  provider.setFilter('未开始');
  let roots = await provider.getChildren();
  assert.equal(roots.length, 1);
  assert.equal(provider.getTreeItem(roots[0]).label, '示例比赛（未开始）');

  provider.setFilter('不存在的比赛');
  roots = await provider.getChildren();
  assert.equal(roots.length, 1, '空结果应给出一行提示节点');
  assert.equal(provider.getTreeItem(roots[0]).contextValue, undefined);

  provider.setFilter('');
  roots = await provider.getChildren();
  assert.equal(roots.length, 3);
});

await testAsync('每道题都能打开，题面 HTML 含正确的 CSP', async () => {
  const service = findService();
  for (const id of ['sample-problem-a', 'sample-problem-b', 'sample-problem-c', 'sample-problem-d', 'sample-problem-e']) {
    await service.openProblem(id);
  }
  assert.equal(captured.panels.length, 5, `期望 5 个面板，实际 ${captured.panels.length}`);

  for (const panel of captured.panels) {
    assert.ok(panel.webview.html.includes('Content-Security-Policy'), `${panel.title} 缺少 CSP`);
    assert.ok(
      panel.webview.html.includes("frame-src https://view.officeapps.live.com"),
      `${panel.title} 的 CSP 未允许 Office 在线预览 iframe`,
    );
    assert.ok(panel.webview.html.includes('worker-src blob:'), `${panel.title} 的 CSP 未允许 blob worker`);
    assert.ok(/nonce-[A-Za-z0-9]{32}/.test(panel.webview.html), `${panel.title} 缺少 script nonce`);
    // 扩展侧是收到 webview 的 ready 之后才推内容的。
    await panel.webview.receiveMessage({ type: 'ready' });
  }
  assert.equal(captured.messages.length, 5, `期望 5 条内容消息，实际 ${captured.messages.length}`);
});

await testAsync('PDF 题面把字节流经 postMessage 送给 webview', async () => {
  const pdfMessage = captured.messages.find((m) => m.kind === 'pdf');
  assert.ok(pdfMessage, '没有收到 pdf 内容消息');
  assert.ok(pdfMessage.base64.length > 100, 'base64 内容为空');
  const bytes = Buffer.from(pdfMessage.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', '不是合法 PDF');
});

await testAsync('DOCX 题面带上公网地址与本地副本标记', async () => {
  const docxMessage = captured.messages.find((m) => m.kind === 'docx');
  assert.ok(docxMessage, '没有收到 docx 内容消息');
  assert.match(docxMessage.publicUrl, /^https:/);
  assert.equal(docxMessage.hasLocalCopy, true);
  assert.equal(docxMessage.mode, 'download', 'DOCX 默认走本地下载（接口要登录态，在线预览抓不到）');
  assert.equal(docxMessage.extension, 'docx');
  assert.ok(docxMessage.savedPath, '应当已经落盘');
});

await testAsync('HTML 题面注入了内容且摘掉了 script', async () => {
  const htmlMessage = captured.messages.find((m) => m.kind === 'html');
  assert.ok(htmlMessage, '没有收到 html 内容消息');
  assert.ok(htmlMessage.html.includes('并查集'), 'HTML 题面内容缺失');
  assert.ok(!/<script/i.test(htmlMessage.html), 'script 标签没有被摘掉');
});

await testAsync('没有附件的题目给出兜底提示', async () => {
  const noneMessage = captured.messages.find((m) => m.kind === 'none');
  assert.ok(noneMessage, '没有收到 none 内容消息');
  assert.ok(noneMessage.reason.length > 0);
});

// ----------------------------------------------------------- 样例文件校验

await testAsync('PDF 放大后横向能滚到最左（不能用 align-items: center 居中）', async () => {
  // 先把注释剥掉：注释里为了解释「为什么不能用 center」正好写着这个词。
  const css = (await readFile(join(projectRoot, 'media', 'problem.css'), 'utf8')).replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `找不到 ${selector} 规则`);
    return css.slice(start, css.indexOf('}', start));
  };

  // 放大到比可视区还宽时，居中会把溢出平分到左右两侧；scrollLeft 不能为负，
  // 于是左边那半页永远滚不到 —— 表现就是「页面被切掉，横向滚动条拖不过去」。
  const container = rule('.pdf-container');
  assert.ok(
    /align-items:\s*flex-start/.test(container),
    `\.pdf-container 必须贴左对齐，实际：${container.replace(/\s+/g, ' ')}`,
  );
  assert.ok(
    !/align-items:\s*center/.test(container),
    '\.pdf-container 不能用 align-items: center（会让左侧溢出无法滚动到）',
  );

  // 居中改由 auto margin 承担：放得下时居中放不下时退化成 0。
  assert.ok(/margin:\s*0 auto/.test(rule('.pdf-page')), '.pdf-page 应当用 margin: 0 auto 居中');
});

await testAsync('内置样例 PDF 能被 pdf.js 真实解析', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(join(projectRoot, 'media', 'sample-statement.pdf')));
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: join(projectRoot, 'media', 'vendor', 'pdfjs', 'standard_fonts') + '/',
    useSystemFonts: false,
    isEvalSupported: false,
    enableScripting: false,
  });
  const doc = await loadingTask.promise;
  assert.equal(doc.numPages, 1, '样例 PDF 应为 1 页');
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  const joined = text.items.map((i) => i.str).join(' ');
  assert.ok(joined.includes('Maximum Subarray Sum'), `PDF 文本提取异常: ${joined.slice(0, 120)}`);
  // pdf.js 6 去掉了 doc.destroy()，改成销毁 loadingTask
  await loadingTask.destroy();
});

await testAsync('内置样例 DOCX 是结构完整的 OOXML 包', async () => {
  const bytes = new Uint8Array(await readFile(join(projectRoot, 'media', 'sample-statement.docx')));
  assert.equal(bytes[0], 0x50, 'ZIP 魔数缺失');
  // 用 pdf.js 之外的零依赖方式校验：直接找 central directory 里的文件名。
  const raw = Buffer.from(bytes).toString('latin1');
  for (const entry of ['[Content_Types].xml', 'word/document.xml', '_rels/.rels']) {
    assert.ok(raw.includes(entry), `DOCX 缺少 ${entry}`);
  }
});

// ----------------------------------------------------------- 数据解析容错

await testAsync('normalize 能吃掉各种 OJ 的字段命名', async () => {
  const { normalizeProblem, normalizeSubmission, normalizeVerdict, normalizeProblemDetail } = require(
    join(projectRoot, 'out', 'api', 'normalize.js'),
  );

  const problems = [
    { id: 'fixture-problem-a', title: 'A+B' },
    { problemId: 'fixture-problem-b', name: '最大子段和', difficulty: 'Easy', tags: ['dp'] },
    { pid: 'fixture-problem-c', problem_title: '区间调度', tag: 'greedy,sort' },
    { no: 'fixture-problem-c', label: '<b>并查集</b>', status: 'accepted' },
  ].map((raw, i) => normalizeProblem(raw, String(i + 1)));

  assert.equal(problems[0].id, 'fixture-problem-a');
  assert.equal(problems[1].id, 'fixture-problem-b');
  assert.equal(problems[1].difficulty, 'Easy');
  assert.deepEqual(problems[1].tags, ['dp']);
  assert.equal(problems[2].id, 'fixture-problem-c');
  assert.deepEqual(problems[2].tags, ['greedy', 'sort']);
  assert.equal(problems[3].title, '并查集', 'HTML 标签应被剥掉');
  assert.equal(problems[3].accepted, true);

  assert.equal(normalizeVerdict('Accepted').verdict, 'accepted');
  assert.equal(normalizeVerdict('Time Limit Exceeded').verdict, 'time_limit_exceeded');
  // 纯数字判定码不再乱猜：只有实证过的码才认，其余一律 unknown，
  // 让界面把原始数字显示出来而不是理直气壮地说错话。
  assert.equal(normalizeVerdict('1').verdict, 'accepted', '1 在 XDOJ 是「正确」，有实证');
  assert.equal(normalizeVerdict('4').verdict, 'unknown', '没实证过的码不能猜');
  assert.equal(normalizeVerdict('99').verdict, 'unknown');
  assert.equal(normalizeVerdict('编译错误').verdict, 'compile_error');
  assert.equal(normalizeVerdict('Running').verdict, 'judging');
  assert.equal(normalizeVerdict('随便什么东西').verdict, 'unknown');

  const submission = normalizeSubmission({
    submission_id: 'abc',
    problem: { id: 'fixture-problem-b', title: '最大子段和' },
    status: 'Wrong Answer',
    language: 'GNU G++17',
    submit_time: 1_700_000_000,
    time_used: 42,
    memory_used: 2048,
  });
  assert.equal(submission.id, 'abc');
  assert.equal(submission.problemId, 'fixture-problem-b');
  assert.equal(submission.problemTitle, '最大子段和');
  assert.equal(submission.verdict, 'wrong_answer');
  assert.equal(submission.createdAt, 1_700_000_000_000, '秒级时间戳应被转成毫秒');
  assert.equal(submission.timeMs, 42);
  assert.equal(submission.memoryKb, 2048);

  const detail = normalizeProblemDetail(
    { id: 'fixture-problem-z', title: 'T', contentUrl: 'a/b.pdf', timeLimit: 2, memoryLimit: 256 * 1024 },
    'fixture-problem-z',
  );
  assert.equal(detail.contentUrl, 'a/b.pdf');
  assert.equal(detail.timeLimitMs, 2000, '秒应转毫秒');
  assert.equal(detail.memoryLimitMb, 256, 'KB 应转 MB');
});

await testAsync('信封结构 {data:{list:[...]}} 能被剥开', async () => {
  const { toArray } = require(join(projectRoot, 'out', 'util', 'text.js'));
  const rows = toArray({ code: 0, data: { list: [{ id: 'fixture-row-1' }, { id: 'fixture-row-2' }] } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'fixture-row-1');
});

// ----------------------------------------------------------- 提交路径

await testAsync('提交当前 cpp 会进入轮询并拿到最终结果', async () => {
  const service = findService();
  const { Uri: StubUri } = vscodeStub;

  // 模拟「焦点在 cpp 编辑器上」：题面面板全部失焦，这样题号应从文件里的 @xdoj 指令推断。
  for (const panel of captured.panels) {
    panel.active = false;
  }
  tabChangeEmitter.fire({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.panels.activeId, undefined, '面板失焦后不应再报告 active 题目');

  // 伪造一个已打开的 cpp 编辑器
  const document = {
    uri: StubUri.file(join(storageDir, 'fixture-problem-b.cpp')),
    fileName: join(storageDir, 'fixture-problem-b.cpp'),
    languageId: 'cpp',
    isDirty: false,
    isUntitled: false,
    getText: () => '// @xdoj fixture-problem-b\n#include <bits/stdc++.h>\nint main(){return 0;}\n',
    save: async () => true,
    lineCount: 3,
  };
  vscodeStub.window.activeTextEditor = { document, viewColumn: 1, options: {}, selection: {} };

  await service.submitActiveFile();

  const store = service.submissions;
  assert.equal(store.size, 1, `期望 1 条新提交，实际 ${store.size}`);
  const record = store.all[0];
  assert.equal(record.problemId, 'fixture-problem-b', '应从文件里的 @xdoj 指令推断出题号');
  assert.equal(record.verdict, 'pending');

  // 样例客户端每次轮询推进一步：judging → judging → 出结果。
  for (let i = 0; i < 4; i++) {
    await service.pollOnce();
  }

  const settled = store.all[0];
  assert.notEqual(settled.verdict, 'pending', '提交应当已离开 pending');
  assert.notEqual(settled.verdict, 'judging', '提交应当已出结果');
  assert.ok(
    captured.infoMessages.some((m) => m.message.includes('已提交')),
    `未弹出提交成功提示：${JSON.stringify(captured.infoMessages)}`,
  );
});

await testAsync('非 cpp 文件会被拒绝提交', async () => {
  const service = findService();
  const before = captured.errorMessages.length;
  vscodeStub.window.activeTextEditor = {
    document: {
      uri: vscodeStub.Uri.file(join(storageDir, 'notes.md')),
      isDirty: false,
      getText: () => '# hi',
      save: async () => true,
    },
    viewColumn: 1,
  };
  await service.submitActiveFile();
  const added = captured.errorMessages.slice(before);
  assert.ok(
    added.some((m) => m.message.includes('只支持提交 C/C++')),
    `未给出后缀校验提示：${JSON.stringify(added)}`,
  );
});

await testAsync('deactivate() 不抛异常', async () => {
  extensionModule.deactivate();
});

await testAsync('配置切到真实 OJ 后客户端类型随之切换，且网络失败被兜住', async () => {
  const service = findService();
  const before = captured.errorMessages.length;

  configValues['xdoj.useMockData'] = false;
  // 指向一个必然拒绝连接的地址，能快速验证错误处理路径。
  configValues['xdoj.endpoint'] = 'http://127.0.0.1:9';
  configChangeEmitter.fire({ affectsConfiguration: (section) => section.startsWith('xdoj') });

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(service.isMock, false, '应切换到 HTTP 客户端');
  assert.equal(service.clientLabel, 'http://127.0.0.1:9');

  const added = captured.errorMessages.slice(before);
  assert.ok(
    added.some((m) => m.message.includes('获取题目列表失败')),
    `网络失败应弹出可读的错误提示，实际：${JSON.stringify(added)}`,
  );
});

// ----------------------------------------------------------------- 登录链路
//
// 真实 OJ 的登录接口形态未知，所以这里把 fetch 换成假的，
// 专门验证「账户+密码 → token/Cookie → 后续请求自动带上」这条我们自己写的逻辑。

console.log('\n登录与会话\n');

const requestLog = [];
let route = () => jsonResponse({});

/** 原生 fetch，供需要真实 undici 行为的用例临时切回来。 */
const nativeFetch = globalThis.fetch;

/** 被测试代码调用的假 fetch。 */
const fakeFetch = async (input, init = {}) => {
  const url = String(input);
  const method = String(init.method ?? 'GET').toUpperCase();
  const parsed = new URL(url);
  const headers = init.headers ?? {};

  // multipart 的 body 是 FormData，拆成 parts 方便断言。
  let body = init.body;
  let parts;
  if (body && typeof body.entries === 'function' && typeof body !== 'string') {
    parts = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push({ name, value });
      } else {
        parts.push({
          name,
          filename: value.name,
          type: value.type,
          content: typeof value.text === 'function' ? await value.text() : undefined,
        });
      }
    }
    body = undefined;
  }

  requestLog.push({ url, method, path: parsed.pathname, headers, body, parts, redirect: init.redirect });
  return route(parsed, method, headers, init.body);
};
globalThis.fetch = fakeFetch;

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** 切换服务端行为，并清空请求记录。 */
function serve(handler) {
  route = handler;
  requestLog.length = 0;
}

/** 把配置改成「真实 OJ 模式」并让 service 重建客户端。 */
async function useRealOj(overrides = {}) {
  const service = findService();
  // configValues 是整个测试共享的，不清掉上一条用例留下的覆盖会互相污染
  // （例如某个用例把 referers.submissions 设成空字符串，后面的用例就一直不发 Referer）。
  delete configValues['xdoj.referers'];
  delete configValues['xdoj.requestHeaders'];
  // 提交相关的覆盖同理：某个用例把 submitFileField 留空、或改了 submitFields，
  // 不清掉就会漏到后面的用例里（GB2312 那条用例正是因此挂过）。
  delete configValues['xdoj.submitFields'];
  delete configValues['xdoj.submitFileField'];
  delete configValues['xdoj.submitEncoding'];
  delete configValues['xdoj.submitTranscode'];
  delete configValues['xdoj.submitPayload'];
  delete configValues['xdoj.classId'];
  Object.assign(configValues, {
    'xdoj.useMockData': false,
    'xdoj.endpoint': 'http://oj.test',
    'xdoj.account': 'alice',
    'xdoj.password': 's3cret',
    'xdoj.endpoints.login': '/api/login',
    'xdoj.endpoints.contests': '',   // 认证用例固定走扁平模式
    // 这些用例靠替换 globalThis.fetch 来拦截，所以必须走 fetch 传输层。
    'xdoj.httpTransport': 'fetch',
    'xdoj.loginPayload': { username: '{account}', password: '{password}' },
    'xdoj.loginContentType': 'json',
    'xdoj.tokenHeader': 'Authorization',
    'xdoj.tokenPrefix': 'Bearer ',
    'xdoj.requestHeaders': {},
    'xdoj.commonQueryParams': { preferLanguage: 'zh_CN' },
    'xdoj.userAgent': 'XdojTest/1.0',
    // 不覆盖 xdoj.referers：让用例直接验证代码里的真实默认值。
    ...overrides,
  });
  // 配置变化会触发一次后台刷新，先给它一个安静的响应，免得污染后面的断言。
  serve(() => jsonResponse({ data: { list: [] } }));
  configChangeEmitter.fire({ affectsConfiguration: (section) => section.startsWith('xdoj') });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await service.session.logout();
  return service;
}

await testAsync('账户+密码登录：拿到 token 和 cookie，后续请求自动带上', async () => {
  const service = await useRealOj();
  serve((parsed) => {
    if (parsed.pathname === '/api/login') {
      return jsonResponse(
        { code: 0, data: { token: 'tok-abc', userId: 'fixture-user' } },
        { headers: { 'set-cookie': 'SESSIONID=s1; Path=/' } },
      );
    }
    if (parsed.pathname === '/api/problems') {
      return jsonResponse({ data: { list: [{ id: 'fixture-problem-x', title: 'A+B' }, { id: 'fixture-problem-y', title: 'C+D' }] } });
    }
    return new Response('not found', { status: 404 });
  });

  await service.login();

  assert.equal(service.session.isLoggedIn, true, '登录后应处于已登录状态');
  assert.equal(service.session.displayAccount, 'alice');
  assert.equal(service.session.current.token, 'tok-abc');
  assert.equal(service.session.current.cookies.length, 1);

  const loginCall = requestLog.find((c) => c.path === '/api/login');
  assert.ok(loginCall, '没有发出登录请求');
  assert.equal(loginCall.method, 'POST');
  assert.equal(loginCall.headers['Content-Type'], 'application/json; charset=UTF-8');
  const body = JSON.parse(loginCall.body);
  assert.deepEqual(body, { username: 'alice', password: 's3cret' }, `登录请求体不对：${loginCall.body}`);

  const problemsCall = requestLog.filter((c) => c.path === '/api/problems').pop();
  assert.ok(problemsCall, '登录后应自动刷新题目列表');
  assert.equal(problemsCall.headers['Authorization'], 'Bearer tok-abc');
  assert.match(String(problemsCall.headers['Cookie']), /SESSIONID=s1/);
  assert.equal(service.getProblems().length, 2, '应解析出 2 道题');
});

await testAsync('登录请求体字段名与 form 编码都能改', async () => {
  const service = await useRealOj({
    'xdoj.loginPayload': { user: '{account}', pass: '{password}', remember: '1' },
    'xdoj.loginContentType': 'form',
  });
  serve((parsed) =>
    parsed.pathname === '/api/login'
      ? jsonResponse({ ok: true, token: 'tok-form' })
      : jsonResponse({ data: { list: [] } }),
  );

  await service.login();

  const loginCall = requestLog.find((c) => c.path === '/api/login');
  assert.equal(loginCall.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(loginCall.body, 'user=alice&pass=s3cret&remember=1');
});

await testAsync('纯 Cookie 认证的 OJ（响应里没有 token）也能登录', async () => {
  const service = await useRealOj();
  serve((parsed) =>
    parsed.pathname === '/api/login'
      ? jsonResponse({ code: 0, message: 'ok' }, { headers: { 'set-cookie': 'PHPSESSID=xyz; Path=/; HttpOnly' } })
      : jsonResponse({ data: { list: [] } }),
  );

  await service.login();

  assert.equal(service.session.current.token, undefined, '没有 token 时不应凭空造一个');
  assert.equal(service.session.current.cookies.length, 1);

  requestLog.length = 0;
  await service.refreshProblems({ silent: true });
  const call = requestLog.find((c) => c.path === '/api/problems');
  assert.equal(call.headers['Authorization'], undefined, 'cookie 模式不该发 Authorization');
  assert.match(String(call.headers['Cookie']), /PHPSESSID=xyz/);
});

await testAsync('200 + 「密码错误」会被识别成登录失败，而不是当成成功', async () => {
  const service = await useRealOj();
  serve(() => jsonResponse({ code: 1, message: '密码错误' }));

  await assert.rejects(
    () => service.session.login(true),
    /密码错误/,
    '应当抛出包含服务端提示的错误',
  );
  assert.equal(service.session.isLoggedIn, false, '登录失败后不应留下会话');
});

await testAsync('token 过期（401）会自动重新登录并重试一次', async () => {
  const service = await useRealOj();
  // 先用旧 token 建立会话
  serve((parsed) => (parsed.pathname === '/api/login' ? jsonResponse({ token: 'tok-old' }) : jsonResponse({})));
  await service.session.login(true);
  assert.equal(service.session.current.token, 'tok-old');

  let problemsAttempts = 0;
  serve((parsed, _method, headers) => {
    if (parsed.pathname === '/api/login') {
      return jsonResponse({ token: 'tok-new' });
    }
    if (parsed.pathname === '/api/problems') {
      problemsAttempts++;
      return headers['Authorization'] === 'Bearer tok-new'
        ? jsonResponse({ data: { list: [{ id: 'fixture-problem-a', title: '重试成功' }] } })
        : new Response('unauthorized', { status: 401 });
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });

  assert.equal(problemsAttempts, 2, `应恰好重试一次，实际请求了 ${problemsAttempts} 次`);
  assert.equal(service.session.current.token, 'tok-new', '应换成新 token');
  assert.equal(service.getProblems().length, 1);
  assert.equal(service.getProblems()[0].title, '重试成功');
});

await testAsync('凭据不全时明确列出缺哪一项', async () => {
  const service = await useRealOj({ 'xdoj.account': '', 'xdoj.password': '' });
  await service.session.clearPassword();

  const missing = await service.session.missingCredentials();
  assert.equal(missing.length, 2, `期望缺 2 项，实际：${JSON.stringify(missing)}`);
  assert.ok(missing.some((m) => m.includes('账户')));
  assert.ok(missing.some((m) => m.includes('密码')));

  await assert.rejects(() => service.session.login(true), /登录信息不完整/);
});

await testAsync('xdoj.requestHeaders 里的手写头优先级高于会话自动生成的头', async () => {
  const service = await useRealOj({
    'xdoj.requestHeaders': { Authorization: 'Token hand-written', 'X-CSRF-Token': 'csrf-1' },
  });
  serve((parsed) =>
    parsed.pathname === '/api/login' ? jsonResponse({ token: 'tok-abc' }) : jsonResponse({ data: { list: [] } }),
  );
  await service.session.login(true);

  requestLog.length = 0;
  await service.refreshProblems({ silent: true });
  const call = requestLog.find((c) => c.path === '/api/problems');
  assert.equal(call.headers['Authorization'], 'Token hand-written', '手写头应覆盖自动生成的');
  assert.equal(call.headers['X-CSRF-Token'], 'csrf-1');
});

await testAsync('会话能跨重启恢复（写入加密凭据库）', async () => {
  const service = await useRealOj();
  serve((parsed) => (parsed.pathname === '/api/login' ? jsonResponse({ token: 'tok-persist' }) : jsonResponse({})));
  await service.session.login(true);

  const stored = secrets.get('xdoj.session');
  assert.ok(stored, '会话应写进 SecretStorage');
  const parsed = JSON.parse(stored);
  assert.equal(parsed.token, 'tok-persist');
  assert.equal(parsed.account, 'alice');

  // 模拟重启：清掉内存里的会话，再 restore
  const { SessionManager } = require(join(projectRoot, 'out', 'auth.js'));
  const revived = new SessionManager(context.secrets, () => service.getConfig());
  await revived.restore();
  assert.equal(revived.isLoggedIn, true, '应从凭据库恢复出会话');
  assert.equal(revived.current.token, 'tok-persist');
  void service;
});

await testAsync('会话不会跨站点或账户恢复 / 发送', async () => {
  const service = await useRealOj();
  serve((parsed) =>
    parsed.pathname === '/api/login'
      ? jsonResponse({ token: 'tok-bound' }, { headers: { 'set-cookie': 'JSESSIONID=BOUND; Path=/' } })
      : jsonResponse({}),
  );
  await service.session.login(true);
  assert.equal(service.session.isLoggedIn, true);

  // 配置切换到另一站点后，即使尚未完成配置事件清理，也不得发送旧凭据。
  service.getConfig().endpoint = 'https://other.test';
  assert.equal(service.session.isLoggedIn, false);
  const headers = await service.session.sessionHeaders();
  assert.ok(!headers['Authorization'], '旧 Token 不得发出');
  assert.ok(!headers['Cookie']?.includes('JSESSIONID=BOUND'), '旧会话 Cookie 不得发出');
  assert.equal(headers['Cookie'], 'preferred_lang=zh_CN', '无登录态时仍允许静态语言偏好 Cookie');

  const { SessionManager } = require(join(projectRoot, 'out', 'auth.js'));
  const revived = new SessionManager(context.secrets, () => service.getConfig());
  await revived.restore();
  assert.equal(revived.isLoggedIn, false, '不同 origin 的持久会话必须拒绝恢复');
  assert.equal(secrets.get('xdoj.session'), undefined, '不匹配的凭据应从 SecretStorage 删除');
});

await testAsync('密码不会泄漏进日志，token 认证头会打码', async () => {
  const service = await useRealOj({ 'xdoj.password': 'super-secret-password' });
  serve((parsed) =>
    parsed.pathname === '/api/login' ? jsonResponse({ token: 't' }) : jsonResponse({ data: { list: [] } }),
  );
  await service.session.login(true);
  // 再发一次带认证头的业务请求，确认头也被脱敏。
  await service.refreshProblems({ silent: true });

  const allLogs = captured.output.flatMap((c) => c.lines).join('\n');
  assert.ok(!allLogs.includes('super-secret-password'), '日志里出现了明文密码！');
  assert.ok(
    allLogs.includes('Authorization: ***') || allLogs.includes('"Authorization":"***"'),
    `认证头应被脱敏成 ***，实际日志片段：${allLogs.slice(-400)}`,
  );
});

// ------------------------------------------------------- XDOJ 的真实登录契约
//
// 这段是按抓包结果写死的：Spring SSM 后端，form-urlencoded，
// 成败靠响应体里的 `error` 字段区分 —— 而且**失败时 HTTP 也是 200、也照样下发 JSESSIONID**。
// 所以「有没有拿到 Cookie」完全不能用来判断登录成败。

console.log('\nXDOJ 登录契约\n');

const XDOJ_LOGIN_CONFIG = {
  'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
  'xdoj.loginPayload': { preferLanguage: 'zh_CN', userId: '{account}', password: '{password}' },
  'xdoj.loginContentType': 'form',
};

const JSESSIONID_HEADER = (id) => ({
  'set-cookie': `JSESSIONID=${id}; Path=/xdoj-ssm; HttpOnly`,
  'content-disposition': 'attachment;filename=f.txt',
  'content-type': 'application/json;charset=UTF-8',
});

await testAsync('登录成功：{error:0} + JSESSIONID，请求体与 Content-Type 完全对得上', async () => {
  const service = await useRealOj(XDOJ_LOGIN_CONFIG);
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/user/login.do'
      ? jsonResponse({ error: 0, userType: 0 }, { headers: JSESSIONID_HEADER('ABC123') })
      : jsonResponse({ data: { list: [{ id: 'fixture-problem-z', title: 'A+B Problem' }] } }),
  );

  await service.login();

  assert.equal(service.session.isLoggedIn, true, '应当登录成功');
  assert.equal(service.session.current.token, undefined, 'XDOJ 用 Cookie 认证，不该凭空造 token');

  const loginCall = requestLog.find((c) => c.path === '/xdoj-ssm/user/login.do');
  assert.ok(loginCall, '没有打到登录接口');
  assert.equal(loginCall.url, 'http://oj.test/xdoj-ssm/user/login.do');
  assert.equal(loginCall.method, 'POST');
  assert.equal(
    loginCall.headers['Content-Type'],
    'application/x-www-form-urlencoded; charset=UTF-8',
  );
  assert.equal(loginCall.body, 'preferLanguage=zh_CN&userId=alice&password=s3cret');
  // 服务端会校验 Referer，UA 也要带
  assert.equal(loginCall.headers['Referer'], 'http://oj.test/xdoj-ssm/login.jsp');
  assert.equal(loginCall.headers['User-Agent'], 'XdojTest/1.0');

  const problemsCall = requestLog.filter((c) => c.url.startsWith('http://oj.test/')).pop();
  assert.match(String(problemsCall.headers['Cookie']), /JSESSIONID=ABC123/, '后续请求应带上会话 Cookie');
  assert.equal(problemsCall.headers['Authorization'], undefined, 'Cookie 认证不该发 Authorization');
  assert.match(problemsCall.url, /preferLanguage=zh_CN/, '公共 query 参数应自动带上');
  assert.equal(problemsCall.headers['Referer'], 'http://oj.test/xdoj-ssm/');
  assert.equal(problemsCall.headers['User-Agent'], 'XdojTest/1.0');
});

await testAsync('User-Agent 留空则不发送，手写头能覆盖', async () => {
  let service = await useRealOj({ 'xdoj.userAgent': '' });
  serve(() => jsonResponse({ data: { list: [] } }));
  await service.refreshProblems({ silent: true });
  let call = requestLog.find((c) => c.url.includes('/api/problems'));
  assert.equal(call.headers['User-Agent'], undefined, 'User-Agent 留空时不该发送');

  service = await useRealOj({
    'xdoj.userAgent': 'MyCustomAgent/9',
    'xdoj.requestHeaders': { 'User-Agent': 'HeaderAgent/2' },
  });
  serve(() => jsonResponse({ data: { list: [] } }));
  await service.refreshProblems({ silent: true });
  call = requestLog.find((c) => c.url.includes('/api/problems'));
  assert.equal(call.headers['User-Agent'], 'HeaderAgent/2', '手写头应压过 xdoj.userAgent');
});

await testAsync('Referer 按接口区分，支持占位符，留空则不发送', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.referers': {
      login: '{endpoint}/xdoj-ssm/login.jsp',
      contests: '{endpoint}/xdoj-ssm/team/contests.do',
      // 带上参数，验证占位符会被替换
      contestProblems: '{endpoint}/xdoj-ssm/team/problems.do?contestId={contestId}',
      // 故意留空：这个接口不该发 Referer
      submissions: '',
    },
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/list.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  assert.equal(roots.length, 1, '应有一场比赛可展开');
  await provider.getChildren(roots[0]);
  await service.refreshSubmissions();

  const contestsCall = requestLog.find((c) => c.path === '/xdoj-ssm/contest/list.do');
  const problemsCall = requestLog.find((c) => c.path === '/xdoj-ssm/contest/problems.do');
  const submissionsCall = requestLog.find((c) => c.path === '/xdoj-ssm/submission/list.do');
  const seen = requestLog.map((c) => `${c.method} ${c.path}`).join('\n    ');
  assert.ok(problemsCall, `没有打到比赛题目接口。已记录：\n    ${seen}`);
  assert.ok(submissionsCall, `没有打到提交记录接口。已记录：\n    ${seen}`);

  assert.equal(contestsCall.headers['Referer'], 'http://oj.test/xdoj-ssm/team/contests.do');
  assert.equal(
    problemsCall.headers['Referer'],
    'http://oj.test/xdoj-ssm/team/problems.do?contestId=fixture-contest',
    'Referer 模板里的 {contestId} 应被替换',
  );
  assert.equal(submissionsCall.headers['Referer'], undefined, '留空的接口不该发 Referer');

  // 三个接口的 Referer 互不相同，说明确实是按接口来的
  assert.notEqual(contestsCall.headers['Referer'], problemsCall.headers['Referer']);
});

await testAsync('手写的 Referer 压过 xdoj.referers', async () => {
  const service = await useRealOj({
    'xdoj.requestHeaders': { Referer: 'http://manual.example/page' },
  });
  serve(() => jsonResponse({ data: { list: [] } }));
  await service.refreshProblems({ silent: true });
  const call = requestLog.find((c) => c.url.includes('/api/problems'));
  assert.equal(call.headers['Referer'], 'http://manual.example/page');
});

await testAsync('登录失败也发 JSESSIONID 且返回 200 —— 必须判定为失败', async () => {
  const service = await useRealOj(XDOJ_LOGIN_CONFIG);
  // 这句就是为了复现你说的情况：HTTP 200 + 崭新的 JSESSIONID + {"error":1}
  serve(() => jsonResponse({ error: 1 }, { status: 200, headers: JSESSIONID_HEADER('FAILED-SESSION') }));

  await assert.rejects(
    () => service.session.login(true),
    /登录被拒绝/,
    'error:1 必须被识别成失败，不能被 200 和 Cookie 骗过去',
  );
  assert.equal(service.session.isLoggedIn, false, '登录失败后绝不能留下会话');
  assert.equal(secrets.has('xdoj.session'), false, '失败的会话不该写进凭据库');
});

await testAsync('重新登录被拒时，清掉已经失效的旧会话', async () => {
  const service = await useRealOj(XDOJ_LOGIN_CONFIG);

  // 先成功登录一次
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/user/login.do'
      ? jsonResponse({ error: 0, userType: 0 }, { headers: JSESSIONID_HEADER('OLD') })
      : jsonResponse({ data: { list: [] } }),
  );
  await service.session.login(true);
  assert.equal(service.session.isLoggedIn, true);

  // 服务端改口令后，同样的请求只会得到 error:1
  serve(() => jsonResponse({ error: 1 }, { headers: JSESSIONID_HEADER('NEW-BUT-USELESS') }));
  await assert.rejects(() => service.session.login(true), /登录被拒绝/);

  assert.equal(service.session.isLoggedIn, false, '旧会话已失效，应当被清掉');
  assert.equal(secrets.has('xdoj.session'), false, '凭据库里也不该留下失效会话');
});

await testAsync('业务接口返回 401 时会重新登录，成功后用新 JSESSIONID 重试', async () => {
  const service = await useRealOj(XDOJ_LOGIN_CONFIG);

  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/user/login.do'
      ? jsonResponse({ error: 0, userType: 0 }, { headers: JSESSIONID_HEADER('GOOD') })
      : jsonResponse({ data: { list: [] } }),
  );
  await service.session.login(true);

  let attempts = 0;
  serve((parsed, _method, headers) => {
    if (parsed.pathname === '/xdoj-ssm/user/login.do') {
      return jsonResponse({ error: 0, userType: 0 }, { headers: JSESSIONID_HEADER('GOOD') });
    }
    attempts++;
    // 旧会话失效：服务端回 401，且顺手下发一个没用的新 JSESSIONID
    if (attempts === 1) {
      return jsonResponse({ error: 1 }, { status: 401, headers: JSESSIONID_HEADER('USELESS') });
    }
    return /JSESSIONID=GOOD/.test(String(headers['Cookie']))
      ? jsonResponse({ data: { list: [{ id: 'fixture-problem-z', title: '重登后拿到' }] } })
      : jsonResponse({ error: 1 }, { status: 401 });
  });

  await service.refreshProblems({ silent: true });

  assert.equal(attempts, 2, `应恰好重试一次，实际 ${attempts} 次`);
  assert.equal(service.getProblems().length, 1);
  assert.equal(service.getProblems()[0].title, '重登后拿到');
});

await testAsync('密码错时不会把明文密码写进任何日志', async () => {
  const service = await useRealOj({ ...XDOJ_LOGIN_CONFIG, 'xdoj.password': 'P@ssw0rd-leak-check' });
  serve(() => jsonResponse({ error: 1 }, { headers: JSESSIONID_HEADER('X') }));

  await assert.rejects(() => service.session.login(true), /登录被拒绝/);

  const allLogs = captured.output.flatMap((c) => c.lines).join('\n');
  assert.ok(!allLogs.includes('P@ssw0rd-leak-check'), '日志里出现了明文密码！');
  // 登录请求体整个都不该被记下来（userId 出现在业务 URL 里是正常的，只查 password= 这个组合）
  assert.ok(!/password=/.test(allLogs), '登录请求体不该被写进日志');
});

// ------------------------------------------------------- 比赛模式（真实契约）
//
// 这段用你抓包拿到的原始响应，验证 jqGrid 那套协议能不能吃下来。

console.log('\n比赛模式\n');


await testAsync('比赛列表：jqGrid 请求体、XHR 头、Cookie 都对得上', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse({}),
  );

  await service.refreshProblems({ silent: true });

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/contest/list.do');
  assert.ok(call, '没有打到比赛列表接口');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(call.headers['X-Requested-With'], 'XMLHttpRequest', '缺 X-Requested-With');
  assert.equal(call.headers['Accept'], 'application/json, text/javascript, */*; q=0.01');
  assert.match(String(call.headers['Cookie']), /preferred_lang=zh_CN/, '缺 preferred_lang Cookie');
  assert.equal(call.headers['Referer'], 'http://oj.test/xdoj-ssm/team/contests.do');

  // nd 是 cache buster，每次请求都应当是新的毫秒时间戳
  const params = new URLSearchParams(call.body);
  assert.equal(params.get('_search'), 'false');
  assert.equal(params.get('rows'), '100');
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('sidx'), '');
  assert.equal(params.get('sord'), 'asc');
  const nd = Number(params.get('nd'));
  assert.ok(Number.isFinite(nd) && nd > 1_600_000_000_000, `nd 应为毫秒时间戳，实际 ${nd}`);
});

await testAsync('比赛响应解析：字段一个不差，problems:[] 不等于「0 题」', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve(() => jsonResponse(XDOJ_CONTEST_LIST_RESPONSE));
  await service.refreshProblems({ silent: true });

  const contests = service.getContests();
  assert.equal(contests.length, 1, `应解析出 1 场比赛，实际 ${contests.length}`);

  const c = contests[0];
  assert.equal(c.id, 'fixture-contest');
  assert.equal(c.title, '示例比赛（进行中）');
  assert.equal(c.statusString, 'Ready');
  assert.equal(c.description, '示例比赛说明');
  assert.equal(c.startTime, '2026-01-05 14:00:00');
  assert.equal(c.endTime, '2026-01-12 23:59:00');
  assert.equal(c.started, true);
  assert.equal(c.running, true);
  assert.equal(c.active, true);
  assert.equal(c.problemCount, undefined, 'problems:[] 表示还没加载，不能显示成 0 题');

  // 树里这个比赛的描述应当包含状态和时间段
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  assert.equal(roots.length, 1);
  const item = provider.getTreeItem(roots[0]);
  assert.equal(item.label, '示例比赛（进行中）');
  assert.match(String(item.description), /Ready/);
  assert.match(String(item.description), /01-05 14:00 ~ 01-12 23:59/);
  assert.ok(!/0 题/.test(String(item.description)), '不该显示「0 题」');
});

await testAsync('展开比赛时按 {contestId} 拉题目，并带进题目索引', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      assert.equal(parsed.searchParams.get('contestId'), 'fixture-contest', 'contestId 没传对');
      return jsonResponse({
        data: [
          { id: 'fixture-problem-x', title: 'A + B Problem', problemId: 'fixture-problem-x' },
          { id: 'fixture-problem-y', title: '最大子段和' },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();

  const children = await provider.getChildren(roots[0]);
  assert.equal(children.length, 2, `应加载出 2 道题，实际 ${children.length}`);

  // 拿到之后题号索引应当已经登记，标题查询不用再请求
  assert.equal(service.problemTitle('fixture-problem-y'), '最大子段和');
  assert.equal(service.findProblem('fixture-problem-x').contestId, 'fixture-contest', '应记下题目属于哪场比赛');
});

await testAsync('没配置 endpoint 时给出可操作的提示，而不是「不支持的协议」', async () => {
  const service = await useRealOj({ 'xdoj.endpoint': '' });
  const before = captured.errorMessages.length;

  await service.refreshProblems();

  const added = captured.errorMessages.slice(before);
  const messages = added.map((entry) => entry.message).join(' / ');
  assert.ok(
    messages.includes('站点根地址'),
    `应当明确说是没填地址，实际：${messages || '(没有报错)'}`,
  );
  assert.ok(
    !messages.includes('不支持的协议'),
    `相对路径不该报成「不支持的协议」，实际：${messages}`,
  );
});

await testAsync('比赛接口留空时退回扁平题目列表', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '',
    'xdoj.endpoints.problems': '/xdoj-ssm/problem/list.do',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/problem/list.do'
      ? jsonResponse({ data: [{ id: 'fixture-problem-b', title: '扁平题一' }, { id: 'fixture-problem-i', title: '扁平题二' }] })
      : jsonResponse({}),
  );

  assert.equal(service.hasContests(), false, '留空应当判定为扁平模式');
  await service.refreshProblems({ silent: true });
  assert.equal(service.getProblems().length, 2);
  assert.equal(service.getContests().length, 0);

  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  assert.equal(roots.length, 2);
  assert.equal(provider.getTreeItem(roots[0]).contextValue, 'xdoj.problem');
});

await testAsync('比赛下题目加载失败时，树里给出可读的提示行', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : new Response('boom', { status: 500 }),
  );

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();

  const children = await provider.getChildren(roots[0]);
  assert.equal(children.length, 1, '失败时应给一行提示而不是抛出去');
  const item = provider.getTreeItem(children[0]);
  assert.match(String(item.label), /加载题目失败/);
  assert.match(String(item.description), /500/);
});


await testAsync('比赛题目：URL 带 userId / jqGrid 参数，字段解析一个不差', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/contest/problems.do');
  assert.ok(call, '没有打到比赛题目接口');
  assert.equal(call.method, 'GET');
  const q = new URL(call.url).searchParams;
  assert.equal(q.get('contestId'), 'fixture-contest');
  assert.equal(q.get('userId'), 'alice', '必须带上 userId');
  assert.equal(q.get('_search'), 'false');
  assert.equal(q.get('rows'), '100');
  assert.equal(q.get('page'), '1');
  assert.equal(q.get('sidx'), '');
  assert.equal(q.get('sord'), 'asc');
  assert.ok(Number(q.get('nd')) > 1_600_000_000_000, 'nd 应为毫秒时间戳');

  const problems = await service.loadContestProblems({ id: 'fixture-contest', title: '示例比赛（进行中）' });
  assert.equal(problems.length, 2);

  const first = problems[0];
  assert.equal(first.id, 'fixture-problem-a');
  assert.equal(first.title, '计算球体重量');
  assert.equal(first.contestId, 'fixture-contest');
  assert.equal(first.difficulty, '入门', 'difficulty=1 应映射成入门');
  assert.equal(first.difficultyRaw, 1);
  assert.equal(first.orderId, 0);
  assert.deepEqual(first.tags, ['基本计算'], 'tags 是 [{id,name}] 形式');
  assert.equal(first.timeLimitMs, 1000, 'timeLimit=1 秒 → 1000ms');
  assert.equal(first.memoryLimitMb, 100, 'memoryLimit=100 是 MB');
  assert.equal(first.accepted, true, 'userAcceptCount=1 表示已通过');

  const second = problems[1];
  assert.equal(second.accepted, false, 'userAcceptCount=0 表示未通过');

  // 比赛内按 orderId 排序，而不是按题号
  assert.deepEqual(problems.map((p) => p.orderId), [0, 1]);

  // 树上的呈现：难度 + 标签，已通过的打勾
  const items = (await provider.getChildren(roots[0])).map((node) => provider.getTreeItem(node));
  assert.match(String(items[0].label), /计算球体重量/);
  assert.match(String(items[0].description), /入门/);
  assert.equal(items[0].iconPath.id, 'pass-filled', '已通过的题应打勾');
  assert.equal(items[1].iconPath.id, 'circle-outline', '未通过的题用空心圈');
  assert.match(String(items[0].tooltip.value), /时限：1000 ms/);
  assert.match(String(items[0].tooltip.value), /内存：100 MB/);
});

await testAsync('题目文本为空说明题面不在这个接口里（text:[]）', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/problems.do'
      ? jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE)
      : jsonResponse(XDOJ_CONTEST_LIST_RESPONSE),
  );

  const problems = await service.loadContestProblems({ id: 'fixture-contest', title: '示例比赛（进行中）' });
  // 列表接口的 text 是空数组，normalize 不应把它当成「有题面内容」
  assert.ok(!problems[0].inlineContent, '不该凭空造出题面');
  assert.equal(problems[0].contentUrl, undefined);
});

// ------------------------------------------------- 题面文件识别与下载
//
// XDOJ 的 downloadTextFile.do 靠 Content-Disposition 给文件名，但**不能盲信后缀**：
// 这个后端的登录响应就是 `attachment;filename=f.txt`，它习惯发通用名。

console.log('\n题面文件识别\n');

const { detectStatementFile, parseContentDisposition, decodeText } = require(
  join(projectRoot, 'out', 'api', 'statement.js'),
);

const PDF_BYTES = new Uint8Array(await readFile(join(projectRoot, 'media', 'sample-statement.pdf')));
const DOCX_BYTES = new Uint8Array(await readFile(join(projectRoot, 'media', 'sample-statement.docx')));

test('按后缀判断：.pdf / .docx / .txt 各归各位', () => {
  assert.equal(detectStatementFile({ filename: '题面.pdf' }).kind, 'pdf');
  assert.equal(detectStatementFile({ filename: 'statement.docx' }).kind, 'docx');
  assert.equal(detectStatementFile({ filename: 'a.txt' }).kind, 'txt');
  assert.equal(detectStatementFile({ filename: 'page.html' }).kind, 'html');
});

test('.doc 直接归为「无法预览」，不再往下猜', () => {
  const detected = detectStatementFile({ filename: '实验报告.doc' });
  assert.equal(detected.kind, 'binary');
  assert.equal(detected.extension, 'doc');
});

test('文件名是 f.txt 但内容是 PDF —— 魔数一票否决', () => {
  const detected = detectStatementFile({ filename: 'f.txt', bytes: PDF_BYTES });
  assert.equal(detected.kind, 'pdf', '不能因为叫 f.txt 就把 PDF 当纯文本渲染');
  assert.equal(detected.extension, 'pdf');
  assert.match(detected.reason, /f\.txt|不可信/);
});

test('文件名是 f.txt 但内容是 ZIP —— 按 docx 处理', () => {
  const detected = detectStatementFile({ filename: 'f.txt', bytes: DOCX_BYTES });
  assert.equal(detected.kind, 'docx');
});

test('没有文件名时退回 Content-Type，再退回魔数', () => {
  assert.equal(detectStatementFile({ contentType: 'application/pdf;charset=binary' }).kind, 'pdf');
  assert.equal(
    detectStatementFile({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }).kind,
    'docx',
  );
  assert.equal(detectStatementFile({ contentType: 'application/octet-stream', bytes: PDF_BYTES }).kind, 'pdf');
  assert.equal(detectStatementFile({ contentType: 'application/octet-stream', bytes: DOCX_BYTES }).kind, 'docx');
});

test('认不出的二进制归为 binary，不硬塞成文本', () => {
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x13, 0x37]);
  const detected = detectStatementFile({ filename: 'blob.bin', bytes: junk });
  assert.equal(detected.kind, 'binary');
});

test('parseContentDisposition 能吃下 filename / filename* / 带路径的名字', () => {
  assert.equal(parseContentDisposition('attachment;filename=f.txt'), 'f.txt');
  assert.equal(parseContentDisposition('attachment; filename="题面.pdf"'), '题面.pdf');
  assert.equal(
    parseContentDisposition("attachment;filename*=UTF-8''%E9%A2%98%E9%9D%A2.pdf"),
    '题面.pdf',
  );
  assert.equal(parseContentDisposition('attachment; filename="C:\\tmp\\a.docx"'), 'a.docx');
  assert.equal(parseContentDisposition('attachment; filename=/var/tmp/b.pdf'), 'b.pdf');
  assert.equal(parseContentDisposition(null), undefined);
});

test('GBK 的 txt 题面不会解码成乱码', () => {
  // "题目" 的 GBK 编码
  const gbk = new Uint8Array([0xcc, 0xe2, 0xc4, 0xbf]);
  assert.equal(decodeText(gbk, 'text/plain; charset=GBK'), '题目');
  // 不声明 charset 时按 UTF-8 兜底，不抛异常
  assert.equal(typeof decodeText(gbk, 'text/plain'), 'string');
});

await testAsync('真实下载：按 Content-Disposition 落盘并渲染', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
    'xdoj.downloadDir': 'problems',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/problem/downloadTextFile.do') {
      return new Response(PDF_BYTES, {
        status: 200,
        headers: {
          // 故意用通用名，验证魔数兜底
          'content-disposition': 'attachment;filename=f.txt',
          'content-type': 'application/octet-stream',
        },
      });
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]); // 展开比赛，把题目灌进索引

  const opened = await openProblemAndCollect(service, 'fixture-problem-a');

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/problem/downloadTextFile.do');
  assert.ok(call, '没有打到题面下载接口');
  assert.equal(new URL(call.url).searchParams.get('problemId'), 'fixture-problem-a');
  assert.equal(call.headers['Referer'], 'http://oj.test/xdoj-ssm/', '题面的 Referer 走 statement 配置');

  const message = opened.content;
  assert.ok(message, '没有收到题面内容消息');
  assert.equal(message.kind, 'pdf', '文件名叫 f.txt，但内容是 PDF，必须按 PDF 渲染');
  assert.equal(message.extension, 'pdf');
  assert.ok(message.savedPath, '应当落盘');
  assert.match(message.savedPath, /problems[\\/]/, `下载目录应含 problems：${message.savedPath}`);
  assert.ok(Buffer.from(message.base64, 'base64').subarray(0, 5).toString('latin1') === '%PDF-');
});

await testAsync('.doc 题面走「下载后本地打开」，不尝试渲染', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
  });
  const docBytes = new Uint8Array(await readFile(join(projectRoot, 'media', 'sample-statement.doc')));
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return new Response(docBytes, {
      status: 200,
      headers: {
        // 中文文件名服务端一般走 RFC 5987 的 filename*，裸非 ASCII 塞进头会让 undici 抛错
        'content-disposition':
          "attachment;filename*=UTF-8''%E5%AE%9E%E9%AA%8C%E6%8A%A5%E5%91%8A%E6%A8%A1%E6%9D%BF.doc",
        'content-type': 'application/msword',
      },
    });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  const message = (await openProblemAndCollect(service, 'fixture-problem-a')).content;
  assert.ok(message, '没有收到题面内容消息');
  assert.equal(message.kind, 'binary');
  assert.equal(message.extension, 'doc');
  assert.equal(message.filename, '实验报告模板.doc');
  assert.ok(message.savedPath);
});

await testAsync('downloadDir 留空时只在标签页里渲染，不落盘', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
    'xdoj.downloadDir': '',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return new Response(PDF_BYTES, {
      status: 200,
      headers: { 'content-disposition': 'attachment;filename=x.pdf' },
    });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  const message = (await openProblemAndCollect(service, 'fixture-problem-a')).content;
  assert.ok(message, '没有收到题面内容消息');
  assert.equal(message.kind, 'pdf');
  assert.equal(message.savedPath, undefined, '留空时不该落盘');
});

await testAsync('没有详情接口时，用比赛题目列表里的信息也能打开题面', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.problem': '',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return new Response(PDF_BYTES, {
      status: 200,
      headers: { 'content-disposition': 'attachment;filename=sphere.pdf' },
    });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  const opened = await openProblemAndCollect(service, 'fixture-problem-a');
  assert.ok(opened.content, '应当收到题面内容');
  assert.match(opened.panel.title, /计算球体重量/, '标题应来自比赛题目列表');
  assert.match(opened.panel.title, /^fixture-problem-a /, '标题应带题号');
});

// ------------------------------------------------------- 提交记录（真实契约）
//
// XDOJ 的 results.do 是**按比赛**查的 jqGrid 接口，一行里同时给了判定数字码
// 和判定文案。字段单位和时间格式与前面几个接口都不太一样。

console.log('\n提交记录\n');

const XDOJ_RESULTS_RESPONSE = {
  totalCount: 12,
  totalpages: 2,
  page: 2,
  data: [
    {
      classId: '',
      contestId: 'fixture-contest',
      id: 'fixture-submission-3',
      judgeTime: '',
      judgement: 1,
      judgementText: '正确',
      jugeId: '',
      language: { id: 2, name: 'GNU C/C++', exefileSuffix: '' },
      languageId: 2,
      memory: 0,
      points: 100.0,
      preprocessResult: 0,
      problem: { id: 'fixture-problem-b', orderId: 0, title: '温度转换', tags: [{ id: 'fixture-tag', name: '基本计算' }] },
      problemId: 'fixture-problem-b',
      sourceCode: [],
      sourceCodeObj: {},
      sourceCodeStr: '',
      sourceFileName: '',
      submitTime: '2026-01-06 19:35:57',
      time: 0,
      userId: 'fixture-account',
      userName: '',
    },
    {
      contestId: 'fixture-contest',
      id: 'fixture-submission-4',
      judgement: 2,
      judgementText: '答案错误',
      language: { id: 2, name: 'GNU C/C++' },
      languageId: 2,
      memory: 12,
      points: 0.0,
      problem: { id: 'fixture-problem-a', title: '计算球体重量' },
      problemId: 'fixture-problem-a',
      submitTime: '2026-01-06 19:32:12',
      time: 37,
      userId: 'fixture-account',
    },
    {
      // 只有数字码、没有文案：验证「学到的映射」能不能用上
      contestId: 'fixture-contest',
      id: 'fixture-submission-5',
      judgement: 2,
      languageId: 2,
      memory: 8,
      points: 0.0,
      problem: { id: 'fixture-problem-a', title: '计算球体重量' },
      problemId: 'fixture-problem-a',
      submitTime: '2026-01-06 19:00:00',
      time: 12,
    },
  ],
};

await testAsync('连续打开多道题共用一栏，不会每开一道就新开一栏', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/team/selectContest.do') {
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/problem/downloadTextFile.do') {
      return jsonResponse({ data: {} });
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  // 先关掉前面用例留下的题面标签，保证从零开始数
  for (const panel of captured.panels.filter((p) => !p._disposed)) {
    panel.dispose();
  }
  const before = captured.panels.length;
  const created = [];
  try {
    await openProblemAndCollect(service, 'fixture-problem-a');
    await openProblemAndCollect(service, 'fixture-problem-b');
    created.push(...captured.panels.slice(before));

    assert.equal(created.length, 2, '两道题应当各开一个标签页');
    assert.ok(
      created[0].viewColumn > 0,
      `第一栏应当是具体栏号，不能是 ViewColumn.Beside（会再开一栏）：${created[0].viewColumn}`,
    );
    assert.equal(
      created[1].viewColumn,
      created[0].viewColumn,
      `第二道题要复用第一道题那一栏，实际 ${created[0].viewColumn} → ${created[1].viewColumn}`,
    );
    for (const panel of created) {
      assert.ok(
        panel.revealCalls.every((call) => call.viewColumn !== -2),
        'reveal 不能传 ViewColumn.Beside —— 那会再开一栏',
      );
    }
  } finally {
    // 收拾干净：留下的标签页会把「当前题目 / 当前比赛」带到后面的用例里。
    for (const panel of created) {
      panel.dispose();
    }
  }
});

await testAsync('提交记录：按比赛 POST，字段与单位解析正确', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/submission/results.do') {
      return jsonResponse(XDOJ_RESULTS_RESPONSE);
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/submission/results.do');
  assert.ok(call, '没有打到提交记录接口');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(call.headers['Referer'], 'http://oj.test/xdoj-ssm/team/results.do');
  const q = new URL(call.url).searchParams;
  assert.equal(q.get('contestId'), 'fixture-contest', '必须带 contestId');
  assert.equal(q.get('userId'), 'alice');
  const body = new URLSearchParams(call.body);
  assert.equal(body.get('_search'), 'false');
  assert.ok(Number(body.get('nd')) > 1_600_000_000_000);

  const list = service.submissions.all;
  assert.equal(list.length, 3);

  const first = list.find((x) => x.id === 'fixture-submission-3');
  assert.equal(first.verdict, 'accepted', 'judgement=1 / judgementText=正确 → 通过');
  assert.equal(first.rawVerdict, '正确');
  assert.equal(first.problemId, 'fixture-problem-b');
  assert.equal(first.problemTitle, '温度转换', 'problem 是嵌套对象，要取 title');
  assert.equal(first.language, 'GNU C/C++', 'language 是对象，要取 name');
  assert.equal(first.languageId, 2);
  assert.equal(first.score, 100);
  assert.equal(
    first.createdAt,
    new Date(2026, 0, 6, 19, 35, 57).getTime(),
    'submitTime 是 "YYYY-MM-DD HH:mm:ss"，要按本地时间解析',
  );

  const second = list.find((x) => x.id === 'fixture-submission-4');
  assert.equal(second.verdict, 'wrong_answer', 'judgementText=答案错误');
  assert.equal(second.timeMs, 37);
  assert.equal(second.memoryKb, 12 * 1024, 'memory 跟 memoryLimit 一样是 MB');
});

await testAsync('只有数字码时，用从文案里学到的映射解码', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse(XDOJ_RESULTS_RESPONSE),
  );

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  // 第三条只有 judgement: 2，映射是从前两条的 judgementText 学来的
  const coded = service.submissions.all.find((x) => x.id === 'fixture-submission-5');
  assert.equal(coded.verdict, 'wrong_answer', '2 → 答案错误 应当是学来的');
  assert.equal(coded.rawVerdict, '2');
});

await testAsync('XDOJ 的 WA 文案是「结果错误」，必须映射成 答案错误 而不是 未知', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse({
          totalCount: 1,
          data: [
            {
              id: 'fixture-submission-2',
              judgement: 2,
              judgementText: '结果错误',
              judgeId: 'fixture-judge',
              memory: 0,
              time: 0,
              language: { id: 2, name: 'GNU C/C++' },
              problemId: 'fixture-problem-d',
              problem: { id: 'fixture-problem-d', title: '判断奇偶性' },
              submitTime: '2026-01-09 21:39:07',
            },
          ],
        }),
  );

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  const row = service.submissions.all[0];
  assert.equal(row.verdict, 'wrong_answer', '「结果错误」是 XDOJ 的 WA 文案，不能掉成 unknown');
  assert.equal(row.rawVerdict, '结果错误');
  assert.equal(row.judgeId, 'fixture-judge', 'judgeId 要留下来，逐测试点结果要用它查');
});

await testAsync('逐测试点结果是懒加载：只有打开提交详情标签页才请求', async () => {
  const JUDGE_RUNS_RESPONSE = {
    totalCount: 3,
    totalpages: 1,
    page: 1,
    data: [
      { id: 'fixture-run-a', memory: 0, output: [], result: 1, runTime: 14, testcaseDescription: '', testcaseId: 'fixture-case-a' },
      { id: 'fixture-run-b', memory: 0, output: [], result: 1, runTime: 15, testcaseDescription: '', testcaseId: 'fixture-case-b' },
      { id: 'fixture-run-c', memory: 0, output: [], result: 2, runTime: 31, testcaseDescription: '', testcaseId: 'fixture-case-c' },
    ],
  };

  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
    'xdoj.endpoints.judgePage': '/xdoj-ssm/team/viewJudge.do?submissionId={id}',
    'xdoj.endpoints.judgeRuns': '/xdoj-ssm/submission/listAllJudgeRun.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/submission/results.do') {
      return jsonResponse({
        totalCount: 1,
        data: [
          {
            id: 'fixture-submission-2',
            judgement: 2,
            judgementText: '结果错误',
            judgeId: 'fixture-judge',
            memory: 0,
            time: 0,
            language: { id: 2, name: 'GNU C/C++' },
            problemId: 'fixture-problem-d',
            problem: { id: 'fixture-problem-d', title: '判断奇偶性' },
            submitTime: '2026-01-09 21:39:07',
          },
        ],
      });
    }
    if (parsed.pathname === '/xdoj-ssm/team/viewJudge.do') {
      // judgeId 和提交 ID 不是同一个号，只能从页面里刮
      return new Response("<script>var judge = { judgeId: 'fixture-judge' };</script>", {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/listAllJudgeRun.do') {
      return jsonResponse(JUDGE_RUNS_RESPONSE);
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  const judgeCalls = () =>
    requestLog.filter((call) => /viewJudge\.do|listAllJudgeRun\.do/.test(call.path));

  assert.equal(judgeCalls().length, 0, '只是列出提交记录时不该碰测试点接口');

  // 关掉之前用例留下的详情页，模拟「用户点开一条提交」
  for (const panel of captured.panels.filter((p) => !p._disposed)) {
    panel.dispose();
  }
  const before = captured.panels.length;
  await service.openSubmission('fixture-submission-2');
  for (let i = 0; i < 10 && judgeCalls().length < 1; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(
    judgeCalls().length,
    1,
    `提交记录里已经带了 judgeId，就只该发一次 listAllJudgeRun，实际：${judgeCalls()
      .map((c) => c.path)
      .join(', ')}`,
  );

  const runsCall = requestLog.find((c) => c.path === '/xdoj-ssm/submission/listAllJudgeRun.do');
  assert.equal(runsCall.method, 'POST');
  assert.equal(runsCall.body, 'judgeId=fixture-judge', 'judgeId 必须是刮出来的那个，不是提交 ID');
  assert.equal(
    runsCall.headers['Referer'],
    'http://oj.test/xdoj-ssm/team/viewJudge.do?submissionId=fixture-submission-2',
  );

  const created = captured.panels.slice(before);
  assert.equal(created.length, 1, '应当开出一个详情页');
  const html = created[0].webview.html;
  assert.match(html, /测试点（2\/3 通过）/, '应当统计通过数');
  assert.match(html, /result=2/, '未知结果码原样展示，不猜');
  assert.match(html, /fixture-case-a/, '要列出测试点编号');
  assert.match(html, /14 ms/);
});

await testAsync('judgeId 从 listJudge.do 换取，不用再刮页面', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
    'xdoj.endpoints.judgeList':
      '/xdoj-ssm/submission/listJudge.do?submissionId={id}&_search=false&nd={timestamp}&rows=5&page=1&sidx=&sord=asc',
    'xdoj.endpoints.judgePage': '/xdoj-ssm/team/viewJudge.do?submissionId={id}',
    'xdoj.endpoints.judgeRuns': '/xdoj-ssm/submission/listAllJudgeRun.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/submission/results.do') {
      return jsonResponse({
        totalCount: 1,
        // 这一行没有 judgeId（后端那个字段常是空串）
        data: [
          {
            id: 'fixture-submission',
            judgement: 1,
            judgementText: '正确',
            jugeId: '',
            memory: 0,
            time: 0,
            problemId: 'fixture-problem-d',
            problem: { id: 'fixture-problem-d', title: '判断奇偶性' },
            submitTime: '2026-01-10 18:43:07',
          },
        ],
      });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/listJudge.do') {
      // 抓包原文：评测记录的 id 就是 judgeId
      return jsonResponse({
        totalCount: 1,
        totalpages: 1,
        page: 1,
        data: [
          {
            compileOutput: [],
            compileOutputStr: '',
            endTime: '2026-01-10 18:43:07',
            id: 'fixture-judge',
            judgement: 1,
            judgementText: '正确',
            memory: 0,
            points: 100,
            preprocessResult: 0,
            problemId: 0,
            startTime: '2026-01-10 18:43:07',
            submissionId: 'fixture-submission',
            time: 0,
          },
        ],
      });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/listAllJudgeRun.do') {
      return jsonResponse({
        totalCount: 1,
        data: [
          { id: 'fixture-run-a', memory: 0, output: [], result: 1, runTime: 14, testcaseId: 'fixture-case-a' },
        ],
      });
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  for (const panel of captured.panels.filter((p) => !p._disposed)) {
    panel.dispose();
  }
  await service.openSubmission('fixture-submission');
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (requestLog.some((c) => c.path === '/xdoj-ssm/submission/listAllJudgeRun.do')) {
      break;
    }
  }

  const listCall = requestLog.find((c) => c.path === '/xdoj-ssm/submission/listJudge.do');
  assert.ok(listCall, '应当先 GET listJudge.do 换 judgeId');
  assert.equal(listCall.method, 'GET');
  const listUrl = new URL(listCall.url);
  assert.equal(listUrl.searchParams.get('submissionId'), 'fixture-submission');
  assert.match(listUrl.searchParams.get('nd') ?? '', /^\d+$/, 'jqGrid 的 nd 要填时间戳');
  assert.equal(
    listCall.headers['Referer'],
    'http://oj.test/xdoj-ssm/team/viewJudge.do?submissionId=fixture-submission',
  );
  assert.equal(listCall.headers['X-Requested-With'], 'XMLHttpRequest');

  const runsCall = requestLog.find((c) => c.path === '/xdoj-ssm/submission/listAllJudgeRun.do');
  assert.ok(runsCall, '换到 judgeId 之后要 POST listAllJudgeRun.do');
  assert.equal(
    runsCall.body,
    'judgeId=fixture-judge',
    `judgeId 来自 listJudge.do 的 id（fixture-judge），不是提交 ID（fixture-submission）：${runsCall.body}`,
  );
  assert.ok(
    !requestLog.some((c) => c.path === '/xdoj-ssm/team/viewJudge.do'),
    '能换到 judgeId 就不该再去刮页面',
  );
});

await testAsync('judgeList 关掉时才退回「从 judge 页面刮 judgeId」', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
    'xdoj.endpoints.judgeList': '',
    'xdoj.endpoints.judgePage': '/xdoj-ssm/team/viewJudge.do?submissionId={id}',
    'xdoj.endpoints.judgeRuns': '/xdoj-ssm/submission/listAllJudgeRun.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/submission/results.do') {
      return jsonResponse({
        totalCount: 1,
        // 这一行没有 judgeId（XDOJ 上它常是空串），只能去页面里刮
        data: [
          {
            id: 'fixture-submission',
            judgement: 2,
            judgementText: '结果错误',
            jugeId: '',
            memory: 0,
            time: 0,
            problemId: 'fixture-problem-d',
            problem: { id: 'fixture-problem-d', title: '判断奇偶性' },
            submitTime: '2026-01-09 21:39:07',
          },
        ],
      });
    }
    if (parsed.pathname === '/xdoj-ssm/team/viewJudge.do') {
      return new Response("<script>listRun({ judgeId: 'fixture-judge' });</script>", {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/listAllJudgeRun.do') {
      return jsonResponse({ totalCount: 0, data: [] });
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  await service.refreshSubmissions();

  for (const panel of captured.panels.filter((p) => !p._disposed)) {
    panel.dispose();
  }
  await service.openSubmission('fixture-submission');
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (requestLog.some((c) => c.path === '/xdoj-ssm/submission/listAllJudgeRun.do')) {
      break;
    }
  }

  const pageCall = requestLog.find((c) => c.path === '/xdoj-ssm/team/viewJudge.do');
  assert.ok(pageCall, '应当先 GET judge 页面刮 judgeId');
  const runsCall = requestLog.find((c) => c.path === '/xdoj-ssm/submission/listAllJudgeRun.do');
  assert.ok(runsCall, '刮到 judgeId 之后要 POST listAllJudgeRun.do');
  assert.equal(
    runsCall.body,
    'judgeId=fixture-judge',
    `judgeId 要从页面里刮（fixture-judge），不能拿提交 ID（fixture-submission）去顶：${runsCall.body}`,
  );
});

await testAsync('提交列表不显示恒为 0 的耗时 / 内存', async () => {
  const { SubmissionTreeProvider } = require(join(projectRoot, 'out', 'views', 'submissionTree.js'));
  const store = findService().submissions;
  // 直接造一条 0 ms / 0 KB 的通过记录（XDOJ 的真实返回就是这样）
  store.upsert({
    id: 'zero-metrics',
    problemId: 'fixture-problem-d',
    problemTitle: '判断奇偶性',
    verdict: 'accepted',
    timeMs: 0,
    memoryKb: 0,
    createdAt: Date.now() - 60_000,
    localOnly: true,
  });

  const provider = new SubmissionTreeProvider(store);
  const node = provider.getChildren().find((n) => n.submission.id === 'zero-metrics');
  const item = provider.getTreeItem(node);
  const description = String(item.description ?? '');
  assert.ok(!/\b0 ms\b/.test(description), `不该出现「0 ms」：${description}`);
  assert.ok(!/0 KB/.test(description), `不该出现「0 KB」：${description}`);
  assert.match(description, /通过/, '状态本身还要在');
});

await testAsync('没有单条查询接口时，getSubmission 退回扫描列表', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    'xdoj.endpoints.submission': '',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse(XDOJ_RESULTS_RESPONSE),
  );

  await service.refreshProblems({ silent: true });

  const found = await service.fetchSubmission('fixture-submission-3');
  assert.ok(found, '应当能在列表里按 id 找到');
  assert.equal(found.verdict, 'accepted');

  const missing = await service.fetchSubmission('does-not-exist');
  assert.equal(missing, undefined);
});

await testAsync('当前比赛跟着最近打开的题目走', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE),
  );

  await service.refreshProblems({ silent: true });
  // 还没展开过比赛 → 退回列表里的第一场
  assert.equal(service.getCurrentContestId(), 'fixture-contest');

  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);
  // 展开后仍然是 fixture-contest，而且题号索引里能查到题目所属比赛
  assert.equal(service.getCurrentContestId(), 'fixture-contest');
  assert.equal(service.findProblem('fixture-problem-a').contestId, 'fixture-contest');
});

// ------------------------------------------------- 提交（真实契约）
//
// XDOJ 的提交是 multipart/form-data，只回 {"code":0,"info":"success"}，**不给提交 ID**，
// 所以提交完只能靠轮询提交记录列表来认领。

console.log('\n提交\n');

/** 你贴过来的那段真实提交页 HTML（截取关键部分，属性顺序保持原样）。 */
const XDOJ_SUBMIT_PAGE_HTML = `
<form name="submit_form" id="submit_form" action="/submission/submit.do" method="post" enctype="multipart/form-data">
  <input type="hidden" value="0" id="solutionType" name="solutionType" />
  <input type="hidden" value="fixture-contest" id="contestId" name="contestId" />
  <input type="hidden" value="fixture-account" id="userId" name="userId" />
  <input type="hidden" value="fixture-class" id="classId" name="classId" />
  <input type="hidden" value="fixture-problem-c" id="problemId" name="problemId" />
  <select class='chosen-select form-control' id='languageId' name='languageId'>
    <option value='2' >GNU C/C++</option>
  </select>
  <input type="file" id="sourceFile" name="sourceFile"/>
  <div id="sourceCode" style="height:300px;border:1px solid grey"></div>
</form>`;

const { parseHiddenInputs, parseSelectOptions, parseFormFields } = require(
  join(projectRoot, 'out', 'util', 'html.js'),
);

test('从提交页刮隐藏字段：属性顺序不固定也能吃下', () => {
  const fields = parseHiddenInputs(XDOJ_SUBMIT_PAGE_HTML);
  // 注意 HTML 里 value 写在 name 前面
  assert.equal(fields.classId, 'fixture-class');
  assert.equal(fields.problemId, 'fixture-problem-c');
  assert.equal(fields.contestId, 'fixture-contest');
  assert.equal(fields.userId, 'fixture-account');
  assert.equal(fields.solutionType, '0');
  // type="file" 的 input 不该被当成隐藏字段（它没有 value，会覆盖成空串）
  assert.equal(fields.sourceFile, undefined);
  // sourceCode 是个 div，本来就不是 input
  assert.equal(fields.sourceCode, undefined);
});

test('解析语言下拉框', () => {
  const languages = parseSelectOptions(XDOJ_SUBMIT_PAGE_HTML, 'languageId');
  assert.deepEqual(languages, { 2: 'GNU C/C++' });
});

/** 造一个「先无提交记录、提交后出现一条」的假后端。 */
function serveSubmitScenario(options = {}) {
  let submittedAt = 0;
  const state = { submitCalls: 0, listCalls: 0 };
  serve((parsed, method, headers, rawBody) => {
    if (parsed.pathname === '/xdoj-ssm/team/submit.do') {
      return new Response(XDOJ_SUBMIT_PAGE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/submit.do') {
      state.submitCalls++;
      submittedAt = Date.now();
      return jsonResponse(options.submitResponse ?? { code: 0, info: 'success' });
    }
    if (parsed.pathname === '/xdoj-ssm/submission/results.do') {
      state.listCalls++;
      if (!submittedAt) {
        return jsonResponse({ totalCount: 0, totalpages: 0, page: 1, data: [] });
      }
      return jsonResponse({
        totalCount: 1,
        totalpages: 1,
        page: 1,
        data: [
          {
            contestId: 'fixture-contest',
            id: 'fixture-submission-6',
            judgement: state.listCalls >= 2 ? 1 : 0,
            judgementText: state.listCalls >= 2 ? '正确' : '等待',
            languageId: 2,
            language: { id: 2, name: 'GNU C/C++' },
            problemId: 'fixture-problem-a',
            problem: { id: 'fixture-problem-a', title: '计算球体重量' },
            submitTime: new Date(submittedAt).toISOString(),
            memory: 3,
            time: 42,
            points: 100,
          },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  });
  return state;
}

async function prepareSubmitContext(overrides = {}) {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
    'xdoj.endpoints.submit': '/xdoj-ssm/submission/submit.do',
    'xdoj.endpoints.submitPage': '/xdoj-ssm/team/submit.do?problemId={problemId}',
    'xdoj.endpoints.submissions': '/xdoj-ssm/submission/results.do?contestId={contestId}&userId={account}',
    ...overrides,
  });

  // 让题号索引里有 9 这道题（拿它所属的比赛）
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE),
  );
  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  // service 是单例，跨用例会累积提交记录和 classId 缓存，这里显式归零。
  service.clearSubmissions();
  service.clearCachedMetadata();

  // 伪造一个打开的 cpp 文件
  vscodeStub.window.activeTextEditor = {
    document: {
      uri: vscodeStub.Uri.file(join(storageDir, 'fixture-problem-a.cpp')),
      fileName: join(storageDir, 'fixture-problem-a.cpp'),
      isDirty: false,
      getText: () => '// @xdoj fixture-problem-a\n#include <iostream>\nint main(){ std::cout << 1; }\n',
      save: async () => true,
    },
    viewColumn: 1,
  };
  return service;
}

await testAsync('提交走 multipart，字段与抓包一致，源码在 sourceFile 文件部分', async () => {
  const service = await prepareSubmitContext();
  const state = serveSubmitScenario();

  await service.submitActiveFile();

  assert.equal(state.submitCalls, 1, '应当提交了一次');
  const call = requestLog.find((c) => c.path === '/xdoj-ssm/submission/submit.do');
  assert.ok(call, '没有打到提交接口');
  assert.equal(call.method, 'POST');
  // 必须自己设 Content-Type：要让 fetch 生成带 boundary 的那个
  assert.equal(
    call.headers['Content-Type'],
    undefined,
    'multipart 的 Content-Type 必须交给 fetch 生成（要带 boundary）',
  );
  assert.equal(call.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(call.headers['Referer'], 'http://oj.test/xdoj-ssm/team/submit.do?problemId=fixture-problem-a');

  const byName = Object.fromEntries(call.parts.map((p) => [p.name, p]));
  assert.equal(byName.solutionType.value, '0');
  assert.equal(byName.contestId.value, 'fixture-contest');
  assert.equal(byName.userId.value, 'alice');
  assert.equal(byName.classId.value, 'fixture-class', 'classId 应当是从提交页刮到的');
  assert.equal(byName.problemId.value, 'fixture-problem-a');
  assert.equal(byName.languageId.value, '2');
  assert.equal(byName.sourceCode.value, '', 'sourceCode 保持空（它本来是 Ace 编辑器）');

  const file = byName.sourceFile;
  assert.ok(file, '缺 sourceFile 文件部分');
  assert.equal(file.filename, 'fixture-problem-a.cpp');
  assert.equal(file.type, 'text/x-c++src');
  assert.match(file.content, /#include <iostream>/, '源码应当在文件部分里');
});

await testAsync('submitFileField 留空时源码走 {code} 文本字段（逃生口）', async () => {
  const service = await prepareSubmitContext({
    'xdoj.submitFileField': '',
    'xdoj.submitFields': {
      solutionType: '0',
      contestId: '{contestId}',
      userId: '{account}',
      classId: '{classId}',
      problemId: '{problemId}',
      languageId: '{language}',
      sourceCode: '{code}',
    },
  });
  serveSubmitScenario();

  await service.submitActiveFile();

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/submission/submit.do');
  assert.ok(call, '没有打到提交接口');
  const byName = Object.fromEntries(call.parts.map((p) => [p.name, p]));
  assert.equal(byName.sourceFile, undefined, '留空后不该再有文件部分');
  assert.match(byName.sourceCode.value, /#include <iostream>/, '源码应当出现在 sourceCode 字段里');
});

await testAsync('submitFileField 留空又没配 {code} 时会警告「提交里没有源码」', async () => {
  const service = await prepareSubmitContext({ 'xdoj.submitFileField': '' });
  serveSubmitScenario();

  await service.submitActiveFile();

  const logs = captured.output.flatMap((c) => c.lines).join('\n');
  assert.match(logs, /不会带任何源码/, `日志里应当有警告：${logs.slice(-400)}`);
});

await testAsync('焦点离开编辑器时，靠最近看过的 cpp 文件兜底', async () => {
  const service = await prepareSubmitContext();
  const state = serveSubmitScenario();

  const cppEditor = {
    document: {
      uri: vscodeStub.Uri.file(join(storageDir, 'fixture-problem-a.cpp')),
      fileName: join(storageDir, 'fixture-problem-a.cpp'),
      languageId: 'cpp',
      encoding: 'utf8',
      isDirty: false,
      isUntitled: false,
      getText: () => '// @xdoj fixture-problem-a\n#include <iostream>\nint main(){ return 0; }\n',
      save: async () => true,
    },
    viewColumn: 1,
  };

  // 先正常激活一下，让扩展记住这个 cpp 编辑器
  setActiveEditor(cppEditor);
  // 然后焦点跑到题面标签页 / 侧栏：activeTextEditor 变成 undefined
  setActiveEditor(undefined, [], [cppEditor]);

  await service.submitActiveFile();

  assert.equal(
    state.submitCalls,
    1,
    'activeTextEditor 为 undefined 时应当退回最近看过的 cpp 文件，而不是报「没有打开文件」',
  );
});

await testAsync('未保存的文件会被拦下，并给出「另存为」选项', async () => {
  const service = await prepareSubmitContext();
  const state = serveSubmitScenario();
  const before = captured.errorMessages.length;

  const untitled = {
    uri: {
      scheme: 'untitled',
      fsPath: 'Untitled-1',
      path: 'Untitled-1',
      toString: () => 'untitled:Untitled-1',
    },
    fileName: 'Untitled-1',
    languageId: 'cpp',
    isDirty: true,
    isUntitled: true,
    getText: () => '#include <iostream>\nint main(){ return 0; }\n',
    save: async () => false,
  };
  setActiveEditor({ document: untitled, viewColumn: 1 });

  await service.submitActiveFile();

  assert.equal(state.submitCalls, 0, '未保存的文件不该被提交');
  const added = captured.errorMessages.slice(before);
  assert.ok(
    added.some((entry) => entry.message.includes('还没保存')),
    `应当提示文件未保存：${JSON.stringify(added)}`,
  );
  assert.ok(
    added.some((entry) => (entry.items ?? []).includes('另存为…')),
    '应当给出「另存为」按钮',
  );
});

await testAsync('选择「另存为」并且保存成功后会继续提交', async () => {
  const service = await prepareSubmitContext();
  const state = serveSubmitScenario();

  const savedPath = join(storageDir, 'saved-after-prompt.cpp');
  const savedSource = '// @xdoj fixture-problem-a\n#include <iostream>\nint main(){ return 0; }\n';
  await writeFile(savedPath, savedSource);

  const untitled = {
    uri: {
      scheme: 'untitled',
      fsPath: 'Untitled-1',
      path: 'Untitled-1',
      toString: () => 'untitled:Untitled-1',
    },
    fileName: 'Untitled-1',
    languageId: 'cpp',
    isDirty: true,
    isUntitled: true,
    getText: () => savedSource,
    save: async () => false,
  };
  setActiveEditor({ document: untitled, viewColumn: 1 });

  const originalWarn = vscodeStub.window.showWarningMessage;
  vscodeStub.window.showWarningMessage = async (message, ...items) => {
    captured.errorMessages.push({ level: 'warn', message, items });
    return message.includes('还没保存') ? '另存为…' : undefined;
  };
  const disposable = vscodeStub.commands.registerCommand('workbench.action.files.saveAs', async () => {
    // 模拟用户在另存为对话框里存成 .cpp：文档不再是 untitled
    setActiveEditor({
      document: {
        uri: vscodeStub.Uri.file(savedPath),
        fileName: savedPath,
        languageId: 'cpp',
        encoding: 'utf8',
        isDirty: false,
        isUntitled: false,
        getText: () => savedSource,
        save: async () => true,
      },
      viewColumn: 1,
    });
  });

  try {
    await service.submitActiveFile();
  } finally {
    disposable.dispose();
    vscodeStub.window.showWarningMessage = originalWarn;
  }

  assert.equal(state.submitCalls, 1, '另存为成功后应当继续提交');
});

await testAsync('提交页的 classId 会按比赛缓存，不会每次都刮', async () => {
  const service = await prepareSubmitContext();
  serveSubmitScenario();
  await service.submitActiveFile();
  const firstScrape = requestLog.filter((c) => c.path === '/xdoj-ssm/team/submit.do').length;

  await service.submitActiveFile();
  const secondScrape = requestLog.filter((c) => c.path === '/xdoj-ssm/team/submit.do').length;
  assert.equal(firstScrape, 1);
  assert.equal(secondScrape, 1, '同一场比赛只刮一次');
});

await testAsync('提交接口不给 ID 时，轮询列表认领这条提交', async () => {
  const service = await prepareSubmitContext();
  const state = serveSubmitScenario({ submitResponse: { code: 0, info: 'success' } });

  await service.submitActiveFile();

  // 提交后先是一条本地占位记录
  assert.equal(service.submissions.size, 1);
  const placeholder = service.submissions.all[0];
  assert.equal(placeholder.verdict, 'pending');
  assert.ok(placeholder.id.startsWith('local-'), `应当是占位 id，实际 ${placeholder.id}`);

  // 第一次轮询：列表里出现了一条「等待」
  await service.pollOnce();
  const adopted = service.submissions.all[0];
  assert.equal(adopted.id, 'fixture-submission-6', '应当认领到真实提交 ID');
  assert.equal(service.submissions.size, 1, '占位记录要被替换掉，不能留两条');

  // 再轮询一次：出结果
  await service.pollOnce();
  const settled = service.submissions.all[0];
  assert.equal(settled.verdict, 'accepted');
  assert.equal(settled.timeMs, 42);
  assert.equal(settled.memoryKb, 3 * 1024);
  assert.ok(state.listCalls >= 2);
});

await testAsync('提交返回 {code:1} 时算失败，不会假装成功', async () => {
  const service = await prepareSubmitContext();
  serveSubmitScenario({ submitResponse: { code: 1, info: '比赛已结束' } });

  const before = captured.errorMessages.length;
  await service.submitActiveFile();

  assert.equal(service.submissions.size, 0, '失败时不该留下提交记录');
  const added = captured.errorMessages.slice(before);
  assert.ok(
    added.some((m) => m.message.includes('比赛已结束')),
    `应把服务端提示带出来，实际：${JSON.stringify(added)}`,
  );
});

test('parseFormFields 能列出登录表单期望的全部字段', () => {
  // 编一个带身份选择的登录表单：如果真实登录页里有 userType 这类字段而我们没发，
  // 服务端可能就存了另一种类型的用户对象，进而在别的接口上强转失败。
  const loginHtml = `
    <form action="/xdoj-ssm/user/login.do" method="post">
      <input type="hidden" name="preferLanguage" value="zh_CN" />
      <select name="userType">
        <option value="0" selected>学生</option>
        <option value="1">教师</option>
      </select>
      <input type="text" name="userId" />
      <input type="password" name="password" />
      <input type="checkbox" name="remember" value="1" />
      <textarea name="note"></textarea>
    </form>`;

  const fields = parseFormFields(loginHtml);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

  assert.deepEqual(Object.keys(byName).sort(), [
    'note', 'password', 'preferLanguage', 'remember', 'userId', 'userType',
  ]);
  assert.equal(byName.preferLanguage.kind, 'hidden');
  assert.equal(byName.preferLanguage.value, 'zh_CN');
  assert.equal(byName.userType.kind, 'select');
  assert.deepEqual(byName.userType.options, { 0: '学生', 1: '教师' });
  assert.equal(byName.userId.kind, 'text');
  assert.equal(byName.password.kind, 'password');
  assert.equal(byName.remember.value, '1');
  assert.equal(byName.note.kind, 'textarea');
});

// ------------------------------------------------- 登录态失效（302）
//
// XDOJ 的会话过期**不做 401/403，而是 302 到站点根**。
// 如果用 redirect: 'follow'，会静默跟到登录页拿到 HTTP 200，
// 然后被当成正常数据 —— 题面下载甚至会把登录页写成 .pdf。

console.log('\n登录态失效\n');

const LOGIN_PAGE_HTML =
  '<!DOCTYPE html><html><head><title>XDOJ 登录</title></head><body><form id="login"></form></body></html>';

test('所有请求都用 redirect: manual 自己处理跳转', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve(() => jsonResponse({ data: [] }));
  await service.refreshProblems({ silent: true });

  const call = requestLog.find((c) => c.path === '/xdoj-ssm/contest/list.do');
  assert.equal(call.redirect, 'manual', "必须用 manual，不能让 fetch 把 302 悄悄跟掉");
});

await testAsync('302 到站点根 → 自动重登录并重试，业务请求最终成功', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
  });

  let sessionValid = false;
  let expiredHits = 0;
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/user/login.do') {
      sessionValid = true;
      return jsonResponse(
        { error: 0, userType: 0 },
        { headers: { 'set-cookie': 'JSESSIONID=fresh; Path=/xdoj-ssm; HttpOnly' } },
      );
    }
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      if (!sessionValid) {
        expiredHits++;
        return new Response(null, { status: 302, headers: { Location: '/xdoj-ssm/' } });
      }
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });

  assert.equal(expiredHits, 1, '应当撞到一次失效跳转');
  assert.equal(service.getContests().length, 1, '重登录后应当拿到数据');
  const calls = requestLog.filter((c) => c.path === '/xdoj-ssm/contest/list.do');
  assert.equal(calls.length, 2, '应当是「打一次 → 重登 → 再打一次」');
});

await testAsync('302 且重登录也失败时，给出明确错误而不是「不是合法 JSON」', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/user/login.do'
      ? jsonResponse({ error: 1 })
      : new Response(null, { status: 302, headers: { Location: '/xdoj-ssm/' } }),
  );

  const before = captured.errorMessages.length;
  await service.refreshProblems({ silent: true });

  const added = captured.errorMessages.slice(before);
  const text = JSON.stringify(added);
  assert.match(text, /登录态已失效|重新登录/, `错误应指向登录态，实际：${text}`);
  assert.ok(!/不是合法 JSON/.test(text), '不该报「不是合法 JSON」这种误导性错误');
});

await testAsync('题面下载拿到 HTML 登录页时拒绝落盘', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    // 关键：文件名说是 PDF，内容其实是登录页，而且 HTTP 200
    return new Response(LOGIN_PAGE_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'content-disposition': 'attachment;filename=statement.pdf',
      },
    });
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  const message = (await openProblemAndCollect(service, 'fixture-problem-a')).content;
  assert.ok(message, '没有收到内容消息');
  assert.equal(message.kind, 'none', '宁可报错，也不能把登录页当成 PDF');
  assert.match(message.reason, /登录态|HTML/);
  assert.equal(message.savedPath, undefined, '绝不能把登录页写到磁盘上');
});

await testAsync('非登录跳转会被正常跟随', async () => {
  const service = await useRealOj({ 'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do' });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? new Response(null, { status: 302, headers: { Location: '/xdoj-ssm/contest/list2.do' } })
      : jsonResponse(XDOJ_CONTEST_LIST_RESPONSE),
  );

  await service.refreshProblems({ silent: true });
  assert.equal(service.getContests().length, 1, '普通跳转应当被跟随');
  assert.ok(requestLog.some((c) => c.path === '/xdoj-ssm/contest/list2.do'));
});

await testAsync('跨 origin 重定向会被拒绝且不发送认证信息', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.login': '/api/login',
    'xdoj.endpoints.contests': '/api/contests',
  });
  serve((parsed) => {
    if (parsed.pathname === '/api/login') {
      return jsonResponse({ token: 'tok-no-forward' });
    }
    return new Response(null, { status: 302, headers: { Location: 'https://evil.test/collect' } });
  });
  await service.session.login(true);

  requestLog.length = 0;
  await service.refreshProblems({ silent: true });
  assert.equal(requestLog.length, 1, '拒绝跨站跳转后不应请求第三方');
  assert.equal(new URL(requestLog[0].url).origin, 'http://oj.test');
  assert.equal(requestLog[0].headers['Authorization'], 'Bearer tok-no-forward');
  assert.ok(!requestLog.some((call) => new URL(call.url).origin === 'https://evil.test'));
});

await testAsync('跨 origin 的显式 URL 不带会话或自定义凭据头', async () => {
  const service = await useRealOj({
    'xdoj.requestHeaders': { Authorization: 'Manual token', 'X-API-Key': 'manual-secret' },
  });
  serve((parsed) => (parsed.pathname === '/api/login' ? jsonResponse({ token: 'tok-origin' }) : jsonResponse({})));
  await service.session.login(true);

  requestLog.length = 0;
  await service.client.probe('GET', 'https://evil.test/collect');
  assert.equal(requestLog.length, 1);
  assert.equal(new URL(requestLog[0].url).origin, 'https://evil.test');
  assert.equal(requestLog[0].headers['Authorization'], undefined);
  assert.equal(requestLog[0].headers['X-API-Key'], undefined);
  assert.equal(requestLog[0].headers['Cookie'], undefined);
});

// ------------------------------------------------- 诊断命令
//
// 5xx 这类失败光看界面上的「HTTP 500」定位不了，诊断命令要把服务端响应体带出来。

console.log('\n诊断\n');

await testAsync('诊断会逐个接口探活，并对 rows 做对照实验', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.contestProblems':
      '/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}&_search=false&nd={timestamp}&rows=100&page=1&sidx=&sord=asc',
    'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
  });

  // 复现你遇到的情况：比赛列表正常，比赛题目 500，而且只在 rows=100 时炸
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      if (parsed.searchParams.get('rows') === '100') {
        return new Response(TOMCAT_500_HTML, {
          status: 500,
          headers: { 'content-type': 'text/html;charset=utf-8' },
        });
      }
      return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return new Response('not found', { status: 404 });
  });

  await service.refreshProblems({ silent: true });
  const clipboardBefore = captured.clipboard.length;
  await service.runDiagnostics();

  assert.equal(captured.clipboard.length, clipboardBefore + 1, '报告应当复制到剪贴板');
  const report = captured.clipboard[captured.clipboard.length - 1];

  assert.match(report, /XDOJ 诊断报告/);
  assert.match(report, /比赛列表/);
  assert.match(report, /比赛题目（当前配置）/);
  assert.match(report, /比赛题目（rows=10 对照）/, '应当自动给出 rows 对照实验');
  assert.match(report, /FAIL/, 'rows=100 那条应当标记失败');
  assert.match(report, /OK/, 'rows=10 那条应当标记成功');
  // 必须从 Tomcat 错误页里把那句异常抠出来，而不是丢一堆标签噪声
  assert.match(report, /ClassCastException/, '必须把服务端的异常带出来');
  assert.match(report, /Request processing failed/, '应当取「消息」那一行');
  assert.ok(
    !/font-family|Tahoma|<html/i.test(report),
    `摘要里不该混进 HTML/CSS 噪声：${report}`,
  );
  assert.match(report, /HTTP 500/);
});

await testAsync('诊断不会因为接口全挂而抛异常', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve(() => {
    throw new Error('socket hang up');
  });
  await service.runDiagnostics();
  const report = captured.clipboard[captured.clipboard.length - 1];
  assert.match(report, /XDOJ 诊断报告/);
  assert.match(report, /FAIL/);
});

await testAsync('Cookie 顺序：JSESSIONID 必须排在额外 Cookie 前面', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
    'xdoj.extraCookies': { preferred_lang: 'zh_CN' },
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/user/login.do'
      ? jsonResponse({ error: 0 }, { headers: { 'set-cookie': 'JSESSIONID=SESSIONVALUE; Path=/xdoj-ssm' } })
      : jsonResponse({ data: [] }),
  );
  await service.session.login(true);
  await service.refreshProblems({ silent: true });

  const call = requestLog.filter((c) => c.path === '/xdoj-ssm/contest/list.do').pop();
  const cookie = String(call.headers['Cookie'] ?? '');
  // 浏览器与能跑通的 curl 都是这个顺序。顺序错了，某些实现用 cookies[0]
  // 取 session id 就会拿到 preferred_lang，接着强转失败抛 ClassCastException。
  assert.ok(
    cookie.startsWith('JSESSIONID='),
    `JSESSIONID 必须在最前面，实际：${cookie}`,
  );
  assert.match(cookie, /JSESSIONID=SESSIONVALUE/);
  assert.match(cookie, /preferred_lang=zh_CN/);
  assert.ok(
    cookie.indexOf('JSESSIONID') < cookie.indexOf('preferred_lang'),
    'preferred_lang 不能跑到 JSESSIONID 前面',
  );
});

await testAsync('诊断会二分出到底是哪个请求头导致失败', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.contestProblems':
      '/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}&rows=100&page=1&sidx=&sord=asc',
  });

  // 服务端只在带 X-Requested-With 时炸 —— 二分应该把这一项指出来
  const culprit = 'X-Requested-With';
  serve((parsed, _method, headers) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return headers[culprit]
        ? new Response(TOMCAT_500_HTML, { status: 500, headers: { 'content-type': 'text/html' } })
        : jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
    }
    return jsonResponse({ data: [] });
  });

  await service.refreshProblems({ silent: true });
  await service.runDiagnostics();
  const report = captured.clipboard[captured.clipboard.length - 1];

  assert.match(report, /二分定位/, '报告里应当有二分段落');
  assert.match(report, /\[FAIL\] 完整请求（当前）/);
  assert.match(
    report,
    new RegExp(`\\[OK  \\] 摘掉 ${culprit}`),
    `应当指出是 ${culprit} 导致的失败：\n${report}`,
  );
  // 二分里除了元凶那条，其它摘除项都该仍然是 FAIL
  assert.match(report, /\[FAIL\] 摘掉 Accept-Language/);
  assert.match(report, /\[FAIL\] 摘掉 Cookie/);
  // 报告里要给出一条能直接跑的 curl
  assert.match(report, /curl -i -X GET/);
});

await testAsync('换会话实验：能判定问题出在扩展的登录会话上', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
    'xdoj.endpoints.loginPage': '/xdoj-ssm/login.jsp',
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.endpoints.contestProblems':
      '/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}&rows=100&page=1&sidx=&sord=asc',
  });

  // 复现真实症状：直接 POST 登录产生的会话会让 problems.do 抛 ClassCastException；
  // 只有「先打开登录页再登录」的会话才能正常返回。
  const pageSessions = new Set();
  const warmed = new Set();
  serve((parsed, _method, headers) => {
    const cookie = String(headers['Cookie'] ?? '');
    const sid = /JSESSIONID=([^;]+)/.exec(cookie)?.[1] ?? '';

    if (parsed.pathname === '/xdoj-ssm/login.jsp') {
      pageSessions.add('PAGESESSION');
      return new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'JSESSIONID=PAGESESSION; Path=/xdoj-ssm' },
      });
    }
    if (parsed.pathname === '/xdoj-ssm/user/login.do') {
      if (pageSessions.has(sid)) {
        warmed.add(sid);
      }
      return jsonResponse({ error: 0 }, { headers: { 'set-cookie': `JSESSIONID=${sid || 'DIRECT'}; Path=/xdoj-ssm` } });
    }
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/contest/problems.do') {
      return warmed.has(sid)
        ? jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE)
        : new Response(TOMCAT_500_HTML, { status: 500, headers: { 'content-type': 'text/html' } });
    }
    return jsonResponse({ data: [] });
  });

  await service.session.login(true);
  await service.refreshProblems({ silent: true });
  await service.runDiagnostics();

  const report = captured.clipboard[captured.clipboard.length - 1];
  assert.match(report, /换会话实验/, '报告里应当有换会话实验');
  assert.match(report, /GET .*login\.jsp/, '应当先打开登录页');
  assert.match(report, /⇒ 结论：问题出在扩展的登录会话上/, `应当给出明确结论：\n${report}`);
  assert.match(report, /\[OK  \] 用这个新会话重试/);
});

// ------------------------------------------------- node 传输层（真实 HTTP）
//
// 这一段起一个真的本地 HTTP 服务器，验证扩展实际发到网线上的字节。
// 前面的用例都跑在假 fetch 上，看不到 undici 自动加的头。

console.log('\n传输层\n');

/** 起一个本地服务器，记录收到的原始请求。 */
async function withLocalServer(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const raw = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      raw.push({ name: req.rawHeaders[i], value: req.rawHeaders[i + 1] });
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: raw, body: Buffer.concat(chunks) };
      seen.push(record);
      handler(record, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

await testAsync('node 传输层不发 undici 的两个自动头', async () => {
  const local = await withLocalServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(XDOJ_CONTEST_LIST_RESPONSE));
  });

  try {
    const service = await useRealOj({
      'xdoj.endpoint': local.origin,
      'xdoj.httpTransport': 'node',
      'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    });
    await service.refreshProblems({ silent: true });

    assert.ok(local.seen.length > 0, '本地服务器没收到请求');
    const names = local.seen[0].headers.map((h) => h.name.toLowerCase());
    // 这两个正是 undici 硬加、fetch API 删不掉的
    assert.ok(!names.includes('accept-encoding'), `不该发 accept-encoding：${names.join(',')}`);
    assert.ok(!names.includes('sec-fetch-mode'), `不该发 sec-fetch-mode：${names.join(',')}`);
    assert.ok(names.includes('x-requested-with'), '该发的还是要发');
    assert.equal(service.getContests().length, 1);
  } finally {
    await local.close();
  }
});

await testAsync('fetch 传输层确实会带上那两个头（对照组）', async () => {
  const local = await withLocalServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(XDOJ_CONTEST_LIST_RESPONSE));
  });

  try {
    const service = await useRealOj({
      'xdoj.endpoint': local.origin,
      'xdoj.httpTransport': 'fetch',
      'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    });
    // 这个用例要看的是**真实 undici** 的行为，所以临时把假 fetch 换掉。
    globalThis.fetch = nativeFetch;
    try {
      await service.refreshProblems({ silent: true });
    } finally {
      globalThis.fetch = fakeFetch;
    }

    assert.ok(local.seen.length > 0, '本地服务器没收到请求');
    const names = local.seen[0].headers.map((h) => h.name.toLowerCase());
    assert.ok(names.includes('accept-encoding'), 'undici 会自动加 accept-encoding');
    assert.ok(names.includes('sec-fetch-mode'), 'undici 会自动加 sec-fetch-mode');
  } finally {
    await local.close();
  }
});

await testAsync('node 传输层能正确收发 Cookie 与二进制题面', async () => {
  const pdf = await readFile(join(projectRoot, 'media', 'sample-statement.pdf'));
  const local = await withLocalServer((req, res) => {
    if (req.url.includes('login.do')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['JSESSIONID=REALVALUE; Path=/xdoj-ssm; HttpOnly'],
      });
      res.end(JSON.stringify({ error: 0 }));
      return;
    }
    if (req.url.includes('downloadTextFile.do')) {
      // 一次下发两条 Set-Cookie，验证多条 cookie 不会丢
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        'content-disposition': 'attachment;filename=real.pdf',
      });
      res.end(pdf);
      return;
    }
    if (req.url.includes('contest/list.do')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(XDOJ_CONTEST_LIST_RESPONSE));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(XDOJ_CONTEST_PROBLEMS_RESPONSE));
  });

  try {
    const service = await useRealOj({
      'xdoj.endpoint': local.origin,
      'xdoj.httpTransport': 'node',
      'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
      'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
      'xdoj.endpoints.contestProblems':
        '/xdoj-ssm/contest/problems.do?contestId={contestId}&userId={account}&rows=100&page=1',
      'xdoj.endpoints.statement': '/xdoj-ssm/problem/downloadTextFile.do?problemId={id}',
    });

    await service.session.login(true);
    assert.equal(
      service.session.current.cookies.length,
      1,
      `登录响应的一条 Set-Cookie 要收到；服务器实际收到：${local.seen.map((r) => r.method + ' ' + r.url).join(', ')}`,
    );
    assert.match(service.session.current.cookies[0], /JSESSIONID=REALVALUE/);

    await service.refreshProblems({ silent: true });
    const provider = makeTreeProvider(service);
    const roots = await provider.getChildren();
    await provider.getChildren(roots[0]);

    const opened = await openProblemAndCollect(service, 'fixture-problem-a');
    assert.ok(opened.content, '应当收到题面内容');
    assert.equal(opened.content.kind, 'pdf', 'PDF 字节要原样拿到（没被 gzip 之类破坏）');
    const decoded = Buffer.from(opened.content.base64, 'base64');
    assert.equal(decoded.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(decoded.length, pdf.length, '二进制长度要一致');
  } finally {
    await local.close();
  }
});

await testAsync('node 传输层能把 multipart 提交正确发出去', async () => {
  let submitBody;
  const local = await withLocalServer((req, res) => {
    if (req.url.includes('submit.do') && req.method === 'POST') {
      submitBody = req.body.toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, info: 'success' }));
      return;
    }
    if (req.url.includes('submit.do')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<input type="hidden" name="classId" value="fixture-class" />');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });

  try {
    const service = await prepareSubmitContext({
      'xdoj.endpoint': local.origin,
      'xdoj.httpTransport': 'node',
      'xdoj.endpoints.submit': '/xdoj-ssm/submission/submit.do',
      'xdoj.endpoints.submitPage': '/xdoj-ssm/team/submit.do?problemId={problemId}',
    });
    await service.submitActiveFile();

    assert.ok(submitBody, '服务器没收到提交请求');
    assert.match(submitBody, /name="sourceFile"; filename="fixture-problem-a\.cpp"/, '源码应当在文件部分');
    assert.match(submitBody, /text\/x-c\+\+src/);
    assert.match(submitBody, /#include <iostream>/, '源码内容要完整');
    assert.match(submitBody, /name="classId"[\s\S]*?fixture-class/, 'classId 要带上');
  } finally {
    await local.close();
  }
});

/**
 * 切换「当前激活的编辑器」，并触发 onDidChangeActiveTextEditor。
 *
 * 桩里的 `window.activeTextEditor` 直接赋值不会发事件，而扩展正是靠这个事件
 * 记住「最后看过的 cpp 文件」，所以要显式 fire 一下。
 */
function setActiveEditor(editor, visible = editor ? [editor] : [], extraVisible = []) {
  vscodeStub.window.activeTextEditor = editor;
  vscodeStub.window.visibleTextEditors = [...visible, ...extraVisible];
  activeEditorEmitter.fire(editor);
}

/**
 * 准备一个走真实 node 传输层的提交上下文。
 * 这几个用例要检查服务器收到的**原始字节**，所以不能用替换 fetch 的方式拦截。
 */
async function prepareDiskSubmit(origin, overrides = {}) {
  const service = await useRealOj({
    'xdoj.endpoint': origin,
    'xdoj.httpTransport': 'node',
    'xdoj.classId': 'fixture-class',
    'xdoj.endpoints.submit': '/xdoj-ssm/submission/submit.do',
    'xdoj.endpoints.submitPage': '',
    'xdoj.endpoints.submissions': '',
    ...overrides,
  });
  service.clearSubmissions();
  service.clearCachedMetadata();
  return service;
}

await testAsync('GB2312 源码按原始字节上传，不会被重新编码成 UTF-8', async () => {
  // 「中文」的 GB2312 编码是 D6 D0 CE C4；同一个词在 UTF-8 里是 E4 B8 AD E6 96 87。
  // 如果扩展把源码当字符串读再编回 UTF-8，上传的字节就会变成后者。
  const gbkChinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const utf8Chinese = Buffer.from('中文', 'utf8');
  const filePath = join(storageDir, 'gb2312.cpp');
  await writeFile(
    filePath,
    Buffer.concat([
      Buffer.from('// ', 'latin1'),
      gbkChinese,
      Buffer.from('\n#include <iostream>\nint main(){return 0;}\n', 'latin1'),
    ]),
  );

  let submitBody;
  const local = await withLocalServer((req, res) => {
    if (req.url.includes('submission/submit.do') && req.method === 'POST') {
      submitBody = req.body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, info: 'success' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });

  try {
    const service = await prepareDiskSubmit(local.origin);

    // 模拟 VS Code 已正确识别成 gbk：编辑器里看到的是真中文。
    vscodeStub.window.activeTextEditor = {
      document: {
        uri: vscodeStub.Uri.file(filePath),
        fileName: filePath,
        languageId: 'cpp',
        encoding: 'gbk',
        isDirty: false,
        isUntitled: false,
        getText: () => '// 中文\n#include <iostream>\nint main(){return 0;}\n',
        save: async () => true,
        lineCount: 3,
      },
      viewColumn: 1,
    };

    await service.submitActiveFile();

    assert.ok(submitBody, '服务器没收到提交请求');
    assert.ok(
      submitBody.includes(gbkChinese),
      '源码应当以 GB2312 原始字节上传（D6 D0 CE C4）',
    );
    assert.ok(
      !submitBody.includes(utf8Chinese),
      '源码不该被重新编码成 UTF-8 —— 那会把文件改坏',
    );
  } finally {
    await local.close();
  }
});

await testAsync('xdoj.submitTranscode=utf8 时才主动转成 UTF-8', async () => {
  const gbkChinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const utf8Chinese = Buffer.from('中文', 'utf8');
  const filePath = join(storageDir, 'gb2312-transcode.cpp');
  await writeFile(filePath, Buffer.concat([Buffer.from('// ', 'latin1'), gbkChinese, Buffer.from('\nint main(){return 0;}\n', 'latin1')]));

  let submitBody;
  const local = await withLocalServer((req, res) => {
    if (req.url.includes('submission/submit.do') && req.method === 'POST') {
      submitBody = req.body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, info: 'success' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });

  try {
    const service = await prepareDiskSubmit(local.origin, { 'xdoj.submitTranscode': 'utf8' });

    vscodeStub.window.activeTextEditor = {
      document: {
        uri: vscodeStub.Uri.file(filePath),
        fileName: filePath,
        languageId: 'cpp',
        encoding: 'gbk',
        isDirty: false,
        isUntitled: false,
        getText: () => '// 中文\nint main(){return 0;}\n',
        save: async () => true,
        lineCount: 2,
      },
      viewColumn: 1,
    };

    await service.submitActiveFile();

    assert.ok(submitBody, '服务器没收到提交请求');
    assert.ok(submitBody.includes(utf8Chinese), '配置成 utf8 后应当发 UTF-8 字节');
    assert.ok(!submitBody.includes(gbkChinese), '这时不该再出现 GB2312 字节');
  } finally {
    await local.close();
  }
});

await testAsync('保存失败时用内存内容，绝不提交磁盘上的旧代码', async () => {
  let submitBody;
  const local = await withLocalServer((req, res) => {
    if (req.url.includes('submission/submit.do') && req.method === 'POST') {
      submitBody = req.body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, info: 'success' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });

  try {
    const service = await prepareDiskSubmit(local.origin);

    const filePath = join(storageDir, 'dirty-save-failed.cpp');
    // 磁盘上还是旧版本
    await writeFile(filePath, '// @xdoj fixture-problem-a\nint main(){ /* 旧版本 */ return 0; }\n');

    setActiveEditor({
      document: {
        uri: vscodeStub.Uri.file(filePath),
        fileName: filePath,
        languageId: 'cpp',
        encoding: 'utf8',
        // 有未保存的修改，但保存失败了
        isDirty: true,
        isUntitled: false,
        getText: () => '// @xdoj fixture-problem-a\nint main(){ /* 新版本 */ return 0; }\n',
        save: async () => false,
      },
      viewColumn: 1,
    });

    await service.submitActiveFile();

    assert.ok(submitBody, '服务器没收到提交请求');
    assert.ok(
      submitBody.includes(Buffer.from('/* 新版本 */', 'utf8')),
      '保存失败时要把内存里的内容发出去',
    );
    assert.ok(
      !submitBody.includes(Buffer.from('/* 旧版本 */', 'utf8')),
      '绝不能退回去提交磁盘上的旧代码',
    );
  } finally {
    await local.close();
  }
});

await testAsync('展开比赛前先 POST selectContest.do 把「当前比赛」写进会话', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/team/selectContest.do') {
      return jsonResponse({ ok: true });
    }
    return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
  });

  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);

  // 顺序：选比赛必须排在 AJAX 之前
  const order = requestLog
    .filter((c) => c.path === '/xdoj-ssm/team/selectContest.do' || c.path === '/xdoj-ssm/contest/problems.do')
    .map((c) => c.path);
  assert.deepEqual(
    order,
    ['/xdoj-ssm/team/selectContest.do', '/xdoj-ssm/contest/problems.do'],
    '必须先选比赛再发 AJAX',
  );

  const select = requestLog.find((c) => c.path === '/xdoj-ssm/team/selectContest.do');
  assert.equal(select.method, 'POST');
  assert.equal(select.body, 'contestId=fixture-contest', '请求体要带上比赛号');
  assert.equal(select.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(select.headers['X-Requested-With'], 'XMLHttpRequest', '这是 AJAX，要带 XRW');
  assert.equal(select.headers['Referer'], 'http://oj.test/xdoj-ssm/team/contests.do');

  // 同一场比赛只预热一次
  await provider.getChildren(roots[0]);
  assert.equal(
    requestLog.filter((c) => c.path === '/xdoj-ssm/team/selectContest.do').length,
    1,
    '同一场比赛只预热一次',
  );
});

await testAsync('换比赛要重新预热，换会话也要', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.login': '/xdoj-ssm/user/login.do',
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
  });
  serve((parsed) => {
    if (parsed.pathname === '/xdoj-ssm/user/login.do') {
      return jsonResponse({ error: 0 }, { headers: { 'set-cookie': 'JSESSIONID=NEW; Path=/xdoj-ssm' } });
    }
    if (parsed.pathname === '/xdoj-ssm/contest/list.do') {
      return jsonResponse(XDOJ_CONTEST_LIST_RESPONSE);
    }
    if (parsed.pathname === '/xdoj-ssm/team/selectContest.do') {
      return jsonResponse({ ok: true });
    }
    return jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE);
  });

  await service.session.login(true);
  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();

  await provider.getChildren(roots[0]); // fixture-contest
  assert.equal(requestLog.filter((c) => c.path === '/xdoj-ssm/team/selectContest.do').length, 1);

  // 换会话 → 之前预热的状态作废，要重做
  await service.session.login(true);
  const provider2 = makeTreeProvider(service);
  const roots2 = await provider2.getChildren();
  await provider2.getChildren(roots2[0]);
  assert.equal(
    requestLog.filter((c) => c.path === '/xdoj-ssm/team/selectContest.do').length,
    2,
    '重新登录后要重新预热',
  );
});

await testAsync('prewarmSteps 留空则跳过预热', async () => {
  const service = await useRealOj({
    'xdoj.endpoints.contests': '/xdoj-ssm/contest/list.do',
    'xdoj.prewarmSteps': [],
  });
  serve((parsed) =>
    parsed.pathname === '/xdoj-ssm/contest/list.do'
      ? jsonResponse(XDOJ_CONTEST_LIST_RESPONSE)
      : jsonResponse(XDOJ_CONTEST_PROBLEMS_RESPONSE),
  );
  await service.refreshProblems({ silent: true });
  const provider = makeTreeProvider(service);
  const roots = await provider.getChildren();
  await provider.getChildren(roots[0]);
  assert.ok(
    !requestLog.some((c) => c.path === '/xdoj-ssm/team/selectContest.do'),
    '留空就不该请求它',
  );
});

// ----------------------------------------------------------------- 收尾

function findService() {
  const { XdojService } = require(join(projectRoot, 'out', 'service.js'));
  // context.subscriptions 里挂着那个唯一的 service 实例
  const found = context.subscriptions.find((item) => item instanceof XdojService);
  assert.ok(found, 'context.subscriptions 里找不到 XdojService 实例');
  return found;
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`--- ${failure.name} ---`);
    console.error(failure.error.stack ?? failure.error.message);
    console.error();
  }
  process.exit(1);
}

// 便捷的同步读文件，仅用于测试断言
function readFileSyncUtf8(path) {
  return require('node:fs').readFileSync(path, 'utf8');
}
