// 把 pdfjs-dist 的运行时静态资源复制到 media/vendor/pdfjs/。
// 扩展本体（Node 侧）不需要 pdfjs，只有题面 Webview 里的 <script type="module"> 需要，
// 所以这里只做文件复制，不引入任何打包器。
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'media', 'vendor', 'pdfjs');

let src;
try {
  src = dirname(require.resolve('pdfjs-dist/package.json'));
} catch {
  console.error('[copy-pdfjs] 找不到 pdfjs-dist，请先运行 npm install');
  process.exit(1);
}

// 只复制运行期真正会用到的部分，跳过体积巨大的 .map 和自带的 web/ 查看器 UI。
const jobs = [
  ['build/pdf.min.mjs', 'pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['standard_fonts', 'standard_fonts'],
  ['cmaps', 'cmaps'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs'],
  ['LICENSE', 'LICENSE'],
];

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

let copied = 0;
for (const [from, to] of jobs) {
  const abs = join(src, from);
  try {
    await stat(abs);
  } catch {
    console.warn(`[copy-pdfjs] 跳过不存在的资源: ${from}`);
    continue;
  }
  await cp(abs, join(dest, to), { recursive: true });
  copied++;
}

const version = require('pdfjs-dist/package.json').version;
await writeFile(join(dest, 'VERSION'), `${version}\n`, 'utf8');
console.log(`[copy-pdfjs] pdfjs-dist@${version} → media/vendor/pdfjs/（${copied}/${jobs.length} 项）`);
