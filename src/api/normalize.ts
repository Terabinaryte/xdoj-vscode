import {
  type Contest,
  type ContentKind,
  type ProblemDetail,
  type ProblemSummary,
  type Submission,
  type TestCaseRun,
  type Verdict,
} from './types';
import { log } from '../logger';
import { extensionOf } from '../util/url';
import {
  pickBoolean,
  pickNumber,
  pickString,
  toArray,
  toEpochMs,
  toPlainTitle,
} from '../util/text';

/** 把任意对象收敛成 ProblemSummary；字段名完全对不上时返回 undefined 交给调用方跳过。 */
export function normalizeProblem(
  raw: unknown,
  fallbackId?: string,
  contestId?: string,
): ProblemSummary | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id =
    pickString(record, ['id', 'problemId', 'problem_id', 'pid', 'no', 'number', 'code']) ?? fallbackId;
  if (id === undefined) {
    return undefined;
  }
  const title =
    pickString(record, ['title', 'name', 'problemTitle', 'problem_title', 'label']) ?? `题目 ${id}`;

  const summary: ProblemSummary = {
    id,
    title: toPlainTitle(title),
    tags: normalizeTags(record),
  };
  const owner = pickString(record, ['contestId', 'contest_id', 'cid']) ?? contestId;
  if (owner) {
    summary.contestId = owner;
  }

  // XDOJ 的 difficulty 是数字（1/2/3…），别的 OJ 可能是 "Easy" 这类字符串。
  const rawDifficulty = record['difficulty'] ?? record['difficultyName'] ?? record['level'] ?? record['rating'];
  if (typeof rawDifficulty === 'number' && Number.isFinite(rawDifficulty)) {
    summary.difficultyRaw = rawDifficulty;
    summary.difficulty = DIFFICULTY_LABELS[rawDifficulty] ?? `难度 ${rawDifficulty}`;
  } else {
    const difficulty = pickString(record, ['difficulty', 'difficultyName', 'level', 'rating']);
    if (difficulty) {
      summary.difficulty = difficulty;
    }
  }

  const orderId = pickNumber(record, ['orderId', 'order_id', 'index', 'seq']);
  if (orderId !== undefined) {
    summary.orderId = orderId;
  }

  const timeLimitMs = pickNumber(record, ['timeLimitMs', 'time_limit_ms']);
  if (timeLimitMs !== undefined) {
    summary.timeLimitMs = timeLimitMs;
  } else {
    // XDOJ 的 timeLimit 单位是秒。
    const seconds = pickNumber(record, ['timeLimit', 'time_limit', 'timeLimitSec']);
    if (seconds !== undefined) {
      summary.timeLimitMs = seconds > 1000 ? seconds : seconds * 1000;
    }
  }

  const memoryLimitMb = pickNumber(record, ['memoryLimitMb', 'memory_limit_mb']);
  if (memoryLimitMb !== undefined) {
    summary.memoryLimitMb = memoryLimitMb;
  } else {
    // XDOJ 的 memoryLimit 单位是 MB（抓包见 100）。
    const memory = pickNumber(record, ['memoryLimit', 'memory_limit']);
    if (memory !== undefined) {
      summary.memoryLimitMb = memory >= 1024 ? Math.round(memory / 1024) : memory;
    }
  }

  const accepted = pickAccepted(record);
  if (accepted !== undefined) {
    summary.accepted = accepted;
  }
  return summary;
}

/** XDOJ 用数字表示难度。这个映射是推断的，对不上改这里即可。 */
const DIFFICULTY_LABELS: Record<number, string> = {
  0: '未评定',
  1: '入门',
  2: '简单',
  3: '中等',
  4: '困难',
  5: '噩梦',
};

function normalizeTags(record: Record<string, unknown>): string[] {
  const raw = record['tags'] ?? record['tag'] ?? record['labels'] ?? record['categories'];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          return pickString(item as Record<string, unknown>, ['name', 'title', 'label']);
        }
        return undefined;
      })
      .filter((v): v is string => !!v);
  }
  const single = pickString(record, ['tags', 'tag', 'category']);
  return single ? single.split(/[,，;；\s]+/).filter(Boolean) : [];
}

function pickAccepted(record: Record<string, unknown>): boolean | undefined {
  const direct = record['accepted'] ?? record['solved'] ?? record['isAccepted'] ?? record['is_accepted'];
  if (typeof direct === 'boolean') {
    return direct;
  }
  // XDOJ 用 userAcceptCount 表示「当前用户在这道题上通过了几次」。
  const userAcceptCount = record['userAcceptCount'] ?? record['user_accept_count'];
  if (typeof userAcceptCount === 'number') {
    return userAcceptCount > 0;
  }
  const status = pickString(record, ['status', 'state', 'userStatus']);
  if (!status) {
    return undefined;
  }
  const s = status.toLowerCase();
  if (['accepted', 'ac', 'solved', 'passed', '1', 'true'].includes(s)) {
    return true;
  }
  if (['attempted', 'failed', 'wa', 'wrong_answer', '0', 'false'].includes(s)) {
    return false;
  }
  return undefined;
}

export function normalizeProblemDetail(raw: unknown, fallbackId: string): ProblemDetail {
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const base =
    normalizeProblem(record, fallbackId) ?? { id: fallbackId, title: `题目 ${fallbackId}`, tags: [] };
  const detail: ProblemDetail = { ...base };

  const contentUrl = pickString(record, [
    'contentUrl', 'content_url', 'statementUrl', 'statement_url', 'pdfUrl', 'pdf_url',
    'docUrl', 'doc_url', 'documentUrl', 'attachmentUrl', 'attachment', 'file', 'url', 'statement',
  ]);
  if (contentUrl) {
    detail.contentUrl = contentUrl;
  }

  const declaredKind = pickString(record, ['contentKind', 'contentType', 'statementType', 'fileType']);
  if (declaredKind) {
    const kind = normalizeKind(declaredKind);
    if (kind !== 'none') {
      detail.contentKind = kind;
    }
  }

  // 有些 OJ 直接把题面塞在详情 JSON 里。
  const inlineHtml = pickString(record, ['description', 'statementHtml', 'contentHtml', 'html']);
  const inlineText = pickString(record, [
    'statementText', 'contentText', 'text', 'content', 'body',
  ]);
  if (inlineHtml && /<[a-z][\s\S]*>/i.test(inlineHtml)) {
    detail.inlineContent = { kind: 'html', body: inlineHtml };
  } else if (inlineText && !contentUrl) {
    detail.inlineContent = { kind: 'txt', body: inlineText };
  }

  const timeLimitMs = pickNumber(record, ['timeLimitMs', 'time_limit_ms']);
  if (timeLimitMs !== undefined) {
    detail.timeLimitMs = timeLimitMs;
  } else {
    // 有的 OJ 用秒，有的用毫秒，超过 1000 一律当毫秒。
    const raw_limit = pickNumber(record, ['timeLimit', 'time_limit', 'timeLimitSec']);
    if (raw_limit !== undefined) {
      detail.timeLimitMs = raw_limit > 1000 ? raw_limit : raw_limit * 1000;
    }
  }

  const memoryLimitMb = pickNumber(record, ['memoryLimitMb', 'memory_limit_mb']);
  if (memoryLimitMb !== undefined) {
    detail.memoryLimitMb = memoryLimitMb;
  } else {
    const rawMemory = pickNumber(record, ['memoryLimit', 'memory_limit']);
    if (rawMemory !== undefined) {
      // 常见写法是 KB；小于 1024 时更像是 MB。
      detail.memoryLimitMb = rawMemory >= 1024 ? Math.round(rawMemory / 1024) : rawMemory;
    }
  }

  return detail;
}

export function normalizeKind(value: string): ContentKind {
  const v = value.trim().toLowerCase();
  if (v.includes('pdf')) {
    return 'pdf';
  }
  if (v.includes('doc')) {
    return 'docx';
  }
  if (v.includes('html') || v.includes('markdown') || v === 'md') {
    return 'html';
  }
  if (v.includes('text') || v.includes('plain') || v === 'txt') {
    return 'txt';
  }
  return 'none';
}

/** 结合 OJ 声明的类型和 URL 扩展名判断题面该怎么渲染。 */
export function resolveContentKind(detail: ProblemDetail): ContentKind {
  if (detail.inlineContent) {
    return detail.inlineContent.kind;
  }
  if (detail.contentKind && detail.contentKind !== 'none') {
    return detail.contentKind;
  }
  if (!detail.contentUrl) {
    return 'none';
  }
  switch (extensionOf(detail.contentUrl)) {
    case 'pdf':
      return 'pdf';
    case 'doc':
    case 'docx':
      return 'docx';
    case 'txt':
    case 'text':
    case 'in':
    case 'out':
      return 'txt';
    case 'html':
    case 'htm':
    case 'md':
      return 'html';
    default:
      return 'none';
  }
}

const VERDICT_ALIASES: Record<string, Verdict> = {
  pending: 'pending', queue: 'pending', queued: 'pending', waiting: 'pending', in_queue: 'pending',
  pd: 'pending', not_judged: 'pending',
  judging: 'judging', running: 'judging', compiling: 'judging', in_progress: 'judging', rj: 'judging',
  accepted: 'accepted', ac: 'accepted', ok: 'accepted', passed: 'accepted', success: 'accepted',
  correct: 'accepted',
  wrong_answer: 'wrong_answer', wa: 'wrong_answer', wrong: 'wrong_answer',
  presentation_error: 'presentation_error', pe: 'presentation_error',
  time_limit_exceeded: 'time_limit_exceeded', tle: 'time_limit_exceeded', timeout: 'time_limit_exceeded',
  memory_limit_exceeded: 'memory_limit_exceeded', mle: 'memory_limit_exceeded',
  output_limit_exceeded: 'output_limit_exceeded', ole: 'output_limit_exceeded',
  runtime_error: 'runtime_error', re: 'runtime_error',
  compile_error: 'compile_error', ce: 'compile_error', compilation_error: 'compile_error',
  system_error: 'system_error', se: 'system_error', judge_error: 'system_error',
};

/**
 * 纯数字判定码 → Verdict。
 *
 * 不在表里的数字一律返回 unknown，由界面把原始数字显示出来 ——
 * 猜错一个码的代价是「界面理直气壮地说错话」，比显示「未知」糟糕得多。
 *
 * 这里只放有实证的：XDOJ 的 `judgement: 1` + `judgementText: "正确"`。
 * 其余的码会在解析到 `judgement` + `judgementText` 同时存在时**自动学出来**，
 * 见 `learnJudgementCode`。
 */
const JUDGEMENT_CODES: Record<string, Verdict> = {
  '1': 'accepted',
};

/** 号码 → Verdict 的学习缓存，靠响应里同时给出的 judgementText 反推。 */
const learnedJudgementCodes = new Map<string, Verdict>();

function learnJudgementCode(code: string, verdict: Verdict): void {
  if (verdict === 'unknown') {
    return;
  }
  const previous = learnedJudgementCodes.get(code);
  if (previous !== verdict) {
    learnedJudgementCodes.set(code, verdict);
    log.info(`[normalize] 学到判定码 ${code} → ${verdict}`);
  }
}

/** 判定码的解码结果。导出来主要是为了测试和排查。 */
export function decodeJudgementCode(code: string): Verdict {
  return learnedJudgementCodes.get(code) ?? JUDGEMENT_CODES[code] ?? 'unknown';
}

export function normalizeVerdict(value: unknown): { verdict: Verdict; raw?: string } {
  const raw =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  if (!raw) {
    return { verdict: 'unknown' };
  }
  const trimmed = raw.trim();
  // 纯数字走判定码表（学习 + 实证），不要和文字别名混在一起 ——
  // '1' 在这个后端是「正确」，在某些 OJ 却是「等待」，猜不得。
  if (/^\d+$/.test(trimmed)) {
    const decoded = decodeJudgementCode(trimmed);
    return decoded === 'unknown' ? { verdict: 'unknown', raw } : { verdict: decoded, raw };
  }

  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  const direct = VERDICT_ALIASES[key];
  if (direct) {
    return { verdict: direct, raw };
  }
  if (/通过|正确|答案正确|accepted|correct/i.test(raw)) {
    return { verdict: 'accepted', raw };
  }
  if (/未评测|待评测|等待评测|排队/.test(raw)) {
    return { verdict: 'pending', raw };
  }
  if (/编译错误|compile/i.test(raw)) {
    return { verdict: 'compile_error', raw };
  }
  if (/超时|time.?limit/i.test(raw)) {
    return { verdict: 'time_limit_exceeded', raw };
  }
  if (/内存|memory/i.test(raw)) {
    return { verdict: 'memory_limit_exceeded', raw };
  }
  if (/输出超限|输出过多|output.?limit/i.test(raw)) {
    return { verdict: 'output_limit_exceeded', raw };
  }
  if (/格式错误|presentation/i.test(raw)) {
    return { verdict: 'presentation_error', raw };
  }
  if (/系统错误|system.?error|judge.?error/i.test(raw)) {
    return { verdict: 'system_error', raw };
  }
  if (/运行|runtime|段错误|segmentation/i.test(raw)) {
    return { verdict: 'runtime_error', raw };
  }
  // XDOJ 的文案是「结果错误」——不含「答案」两个字，所以必须单独列出来，
  // 否则 WA 会一路掉到 unknown（界面上就显示成「未知（原始：结果错误）」）。
  if (/答案错误|结果错误|wrong/i.test(raw)) {
    return { verdict: 'wrong_answer', raw };
  }
  if (/评测中|等待|排队|judging|pending|running/i.test(raw)) {
    return { verdict: 'judging', raw };
  }
  return { verdict: 'unknown', raw };
}

export function normalizeSubmission(raw: unknown): Submission | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = pickString(record, ['id', 'submissionId', 'submission_id', 'sid', 'runId', 'run_id']);
  // 判定：优先文案（judgementText / verdictText 这类），它比数字码可靠；
  // 数字码只在没有文案时用，并且会拿文案反过来学习映射。
  const verdictText = pickString(record, [
    'judgementText', 'judgmentText', 'verdictText', 'statusText', 'resultText',
  ]);
  const verdictCode = record['judgement'] ?? record['judgment'];
  const codeAsString =
    typeof verdictCode === 'number' ? String(verdictCode) : typeof verdictCode === 'string' ? verdictCode : undefined;

  let verdict: Verdict;
  let rawVerdict: string | undefined;
  if (verdictText) {
    const decodedText = normalizeVerdict(verdictText);
    verdict = decodedText.verdict;
    rawVerdict = verdictText;
    // 同时给了码和文案，就把映射记下来，供没有文案的行使用。
    if (codeAsString) {
      learnJudgementCode(codeAsString, verdict);
    }
  } else {
    const verdictSource =
      verdictCode ?? record['verdict'] ?? record['status'] ?? record['result'] ?? record['state'];
    const decoded = normalizeVerdict(verdictSource);
    verdict = decoded.verdict;
    rawVerdict = decoded.raw;
  }

  const problem = record['problem'] ?? record['problemInfo'];
  const problemRecord =
    problem && typeof problem === 'object' ? (problem as Record<string, unknown>) : undefined;

  const submission: Submission = {
    id: id ?? `unknown-${Math.random().toString(36).slice(2, 10)}`,
    verdict,
  };
  if (rawVerdict) {
    submission.rawVerdict = rawVerdict;
  }

  // 逐测试点结果要用 judgeId 查，它和提交 id 不是同一个号。
  // 注意 XDOJ 的字段名是 `jugeId`（后端拼错了，抓包里就是这样）。
  const judgeId = pickString(record, ['judgeId', 'judge_id', 'jugeId', 'juge_id']);
  if (judgeId) {
    submission.judgeId = judgeId;
  }

  const problemId =
    pickString(record, ['problemId', 'problem_id', 'pid']) ??
    (problemRecord ? pickString(problemRecord, ['id', 'problemId']) : undefined);
  if (problemId) {
    submission.problemId = problemId;
  }

  const problemTitle =
    pickString(record, ['problemTitle', 'problem_title', 'problemName']) ??
    (problemRecord ? pickString(problemRecord, ['title', 'name']) : undefined);
  if (problemTitle) {
    submission.problemTitle = toPlainTitle(problemTitle);
  }

  // XDOJ 的 language 是对象 {id, name}；别的 OJ 直接给字符串。
  const languageRaw = record['language'] ?? record['lang'];
  const language =
    languageRaw && typeof languageRaw === 'object' && !Array.isArray(languageRaw)
      ? pickString(languageRaw as Record<string, unknown>, ['name', 'languageName', 'displayName'])
      : pickString(record, ['language', 'lang', 'compiler', 'languageName']);
  if (language) {
    submission.language = language;
  }
  const languageId = pickNumber(record, ['languageId', 'language_id']);
  if (languageId !== undefined) {
    submission.languageId = languageId;
  }

  // 注意 `time` 不在时间戳候选项里：XDOJ 用它表示**运行耗时**（如 37ms），
  // 当成时间戳会算出一个 1970 年的日期。
  const createdAt = toEpochMs(
    record['createdAt'] ??
      record['created_at'] ??
      record['submitTime'] ??
      record['submit_time'] ??
      record['submittedAt'] ??
      record['timestamp'],
  );
  if (createdAt !== undefined) {
    submission.createdAt = createdAt;
  }

  const timeMs = pickNumber(record, ['timeMs', 'time_ms', 'timeCost', 'time_used', 'runtime']);
  if (timeMs !== undefined) {
    submission.timeMs = timeMs;
  } else {
    // `time` 在不同 OJ 里既能是耗时也能是时间戳。耗时不可能超过 ~11 天，
    // 所以只在这个量级以内才当作运行时间。
    const ambiguous = pickNumber(record, ['time']);
    if (ambiguous !== undefined && ambiguous >= 0 && ambiguous < 1e9) {
      submission.timeMs = ambiguous;
    }
  }

  const memoryKb = pickNumber(record, ['memoryKb', 'memory_kb', 'memory_used']);
  if (memoryKb !== undefined) {
    submission.memoryKb = memoryKb;
  } else {
    // XDOJ 的 memory 跟题目里的 memoryLimit 一样是 MB。
    const memoryMb = pickNumber(record, ['memory', 'memoryCost', 'memoryUsed']);
    if (memoryMb !== undefined) {
      submission.memoryKb = memoryMb * 1024;
    }
  }

  const score = pickNumber(record, ['score', 'points']);
  if (score !== undefined) {
    submission.score = score;
  }

  const message = pickString(record, ['message', 'msg', 'errorMessage', 'detail']);
  if (message) {
    submission.message = message;
  }

  const compileOutput = pickString(record, [
    'compileOutput', 'compile_output', 'compilerOutput', 'compiler_output', 'ceInfo', 'judgeDetail',
  ]);
  if (compileOutput) {
    submission.compileOutput = compileOutput;
  }

  return submission;
}

export function normalizeSubmissionList(raw: unknown): Submission[] {
  return toArray(raw)
    .map((item) => normalizeSubmission(item))
    .filter((item): item is Submission => !!item);
}

/**
 * 逐测试点结果。
 *
 * XDOJ 的 `listAllJudgeRun.do` 返回 jqGrid 信封，`data[]` 里每个元素是
 * `{id, judgeId, memory, output, result, runTime, testcaseId}`。
 * `result` 只对 1 有实证（通过），别的码就原样留着让界面展示。
 */
export function normalizeTestCaseRuns(raw: unknown): TestCaseRun[] {
  return toArray(raw)
    .map((item): TestCaseRun | undefined => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const run: TestCaseRun = {};
      const testcaseId = pickString(record, ['testcaseId', 'testcase_id', 'caseId']);
      if (testcaseId) {
        run.testcaseId = testcaseId;
      }
      const result = record['result'] ?? record['resultCode'] ?? record['status'];
      if (typeof result === 'number' || typeof result === 'string') {
        run.resultCode = String(result);
      }
      const runTime = record['runTime'] ?? record['time'] ?? record['runTimeMs'];
      if (typeof runTime === 'number' && runTime > 0) {
        run.runTimeMs = runTime;
      }
      const memory = record['memory'] ?? record['memoryKb'];
      if (typeof memory === 'number' && memory > 0) {
        run.memoryKb = memory;
      }
      return run;
    })
    .filter((run): run is TestCaseRun => !!run);
}

/** 提交接口的响应里挖出提交 ID。 */
export function extractSubmissionId(raw: unknown): string | undefined {
  const direct =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? pickString(raw as Record<string, unknown>, [
          'submissionId', 'submission_id', 'id', 'sid', 'runId', 'run_id',
        ])
      : undefined;
  if (direct) {
    return direct;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return extractSubmissionId(raw[0]);
  }
  if (raw && typeof raw === 'object') {
    for (const key of ['data', 'result', 'payload', 'body']) {
      const nested = (raw as Record<string, unknown>)[key];
      if (nested !== undefined) {
        const found = extractSubmissionId(nested);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ 比赛

const CONTEST_STATUS_KEYS = ['statusString', 'statusText', 'stateString'];

/**
 * 比赛对象。字段名来自 jqGrid 那套后端（`contest/list.do`），
 * 但也尽量兼容别的命名。
 */
export function normalizeContest(raw: unknown): Contest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = pickString(record, ['id', 'contestId', 'contest_id', 'cid']);
  if (id === undefined) {
    return undefined;
  }

  const title = pickString(record, ['title', 'name', 'contestName', 'contest_title']);
  const contest: Contest = {
    id,
    title: toPlainTitle(title ?? `比赛 ${id}`),
  };

  const statusString = pickString(record, CONTEST_STATUS_KEYS);
  if (statusString) {
    contest.statusString = statusString;
  }
  const description = pickString(record, ['description', 'desc', 'remark']);
  if (description) {
    contest.description = description;
  }
  const startTime = pickString(record, ['startTime', 'start_time', 'beginTime']);
  if (startTime) {
    contest.startTime = startTime;
  }
  const endTime = pickString(record, ['endTime', 'end_time', 'stopTime']);
  if (endTime) {
    contest.endTime = endTime;
  }
  for (const [key, field] of [
    ['started', 'started'],
    ['running', 'running'],
    ['active', 'active'],
  ] as const) {
    const value = pickBoolean(record, [key, key === 'running' ? 'isRunning' : `is${key[0].toUpperCase()}${key.slice(1)}`]);
    if (value !== undefined) {
      contest[field] = value;
    }
  }

  // 列表接口通常把 problems 留成空数组——那是「还没加载」而不是「一道题都没有」，
  // 所以只有拿到非空数组时才记账，否则宁可显示未知。
  const embedded = record['problems'] ?? record['problemList'] ?? record['problem_list'];
  if (Array.isArray(embedded)) {
    const problems = embedded
      .map((item) => normalizeProblem(item, undefined, id))
      .filter((p): p is ProblemSummary => !!p);
    if (problems.length > 0) {
      contest.inlineProblems = problems;
      contest.problemCount = problems.length;
    }
  } else {
    const count = pickNumber(record, ['problemCount', 'problem_count', 'problemNum']);
    if (count !== undefined) {
      contest.problemCount = count;
    }
  }

  return contest;
}

export function normalizeContestList(raw: unknown): Contest[] {
  return toArray(raw)
    .map((item) => normalizeContest(item))
    .filter((c): c is Contest => !!c);
}
