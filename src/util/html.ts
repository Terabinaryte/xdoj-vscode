/**
 * 极简 HTML 属性提取。
 *
 * 只用来从 XDOJ 的提交页里刮隐藏字段（`classId` 这类由服务端渲染的值），
 * 不做通用 HTML 解析。
 */

/** 按名字取标签上的属性值，单引号 / 双引号 / 裸值都能吃。 */
export function attributeOf(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) {
    return undefined;
  }
  return unescapeHtml(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * 把页面里所有 `<input>` 的 name → value 收集起来。
 *
 * 注意属性顺序不固定：XDOJ 的表单是 `value="0" id="solutionType" name="solutionType"`
 * —— value 写在 name 前面，所以必须逐个属性解析，不能靠一条正则一次抓完。
 */
export function parseHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tagPattern = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[0];
    const type = attributeOf(tag, 'type');
    if (type && type.toLowerCase() !== 'hidden') {
      continue;
    }
    const name = attributeOf(tag, 'name');
    if (!name) {
      continue;
    }
    out[name] = attributeOf(tag, 'value') ?? '';
  }
  return out;
}

/** `<option value='2'>GNU C/C++</option>` → { "2": "GNU C/C++" } */
export function parseSelectOptions(html: string, selectName: string): Record<string, string> {
  const selectPattern = new RegExp(
    `<select\\b[^>]*\\bname\\s*=\\s*["']?${selectName}["']?[^>]*>([\\s\\S]*?)</select>`,
    'i',
  );
  const select = selectPattern.exec(html);
  if (!select) {
    return {};
  }

  const out: Record<string, string> = {};
  const optionPattern = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  let match: RegExpExecArray | null;
  while ((match = optionPattern.exec(select[1])) !== null) {
    const value = attributeOf(match[0], 'value');
    if (value === undefined) {
      continue;
    }
    out[value] = unescapeHtml(match[1].replace(/<[^>]*>/g, '').trim());
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function unescapeHtml(value: string): string {
  return value
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export interface FormField {
  name: string;
  /** input 的 type，或 `select` / `textarea`。 */
  kind: string;
  value?: string;
  /** select 的候选项，`value → 文案`。 */
  options?: Record<string, string>;
}

/**
 * 列出页面里所有**具名**的表单控件。
 *
 * 和 `parseHiddenInputs` 不同，这个不只看 hidden —— 用来回答
 * 「这个表单到底期望我提交哪些字段」，从而发现我们漏发的参数
 * （比如登录页上可能有个没注意到的 `userType`）。
 */
export function parseFormFields(html: string): FormField[] {
  const out: FormField[] = [];

  const inputPattern = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(html)) !== null) {
    const name = attributeOf(match[0], 'name');
    if (!name) {
      continue;
    }
    out.push({
      name,
      kind: attributeOf(match[0], 'type') ?? 'text',
      value: attributeOf(match[0], 'value'),
    });
  }

  const selectPattern = /<select\b[^>]*>[\s\S]*?<\/select>/gi;
  while ((match = selectPattern.exec(html)) !== null) {
    const name = attributeOf(match[0], 'name');
    if (!name) {
      continue;
    }
    out.push({
      name,
      kind: 'select',
      options: parseSelectOptions(match[0], name),
    });
  }

  const textareaPattern = /<textarea\b[^>]*>/gi;
  while ((match = textareaPattern.exec(html)) !== null) {
    const name = attributeOf(match[0], 'name');
    if (name) {
      out.push({ name, kind: 'textarea' });
    }
  }

  return out;
}
