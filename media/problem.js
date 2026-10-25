// 题面标签页的前端逻辑：接收扩展侧 postMessage 过来的内容并分派渲染。
const vscode = acquireVsCodeApi();

const contentEl = document.getElementById('content');
const statusEl = document.getElementById('status');
const toolbarActions = document.getElementById('toolbar-actions');
const openLocalButton = toolbarActions?.querySelector('[data-action="open-local"]');
const pdfToolbar = document.getElementById('pdf-toolbar');

/** 当前题面原始地址，供「复制 / 浏览器打开」使用。 */
let currentSourceUrl;
/** 题面文件落盘后的绝对路径（配了 xdoj.downloadDir 时才有）。 */
let currentSavedPath;
/** pdf.js 返回的控制器，用于切题时销毁旧文档。 */
let pdfController;

function setStatus(text, isError) {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = text ?? '';
  statusEl.hidden = !text;
  statusEl.classList.toggle('error', !!isError);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function togglePdfToolbar(visible) {
  if (pdfToolbar) {
    pdfToolbar.hidden = !visible;
  }
}

async function destroyPdf() {
  if (pdfController) {
    try {
      pdfController.destroy();
    } catch {
      /* 忽略销毁异常 */
    }
    pdfController = undefined;
  }
}

async function render(message) {
  await destroyPdf();
  togglePdfToolbar(false);
  currentSourceUrl = message.sourceUrl;
  currentSavedPath = message.savedPath;
  if (openLocalButton) {
    openLocalButton.hidden = !currentSavedPath;
  }
  contentEl.classList.remove('no-padding');
  contentEl.textContent = '';
  setStatus('');

  switch (message.kind) {
    case 'pdf':
      await renderPdf(message);
      break;
    case 'docx':
      renderDocx(message);
      break;
    case 'txt':
      renderText(message);
      break;
    case 'html':
      renderHtml(message);
      break;
    case 'binary':
      renderBinary(message);
      break;
    default:
      renderEmpty(message);
      break;
  }
}

async function renderPdf(message) {
  const host = document.createElement('div');
  host.className = 'pdf-host';
  contentEl.appendChild(host);
  contentEl.classList.add('no-padding');

  const pdf = window.XdojPdf;
  if (!pdf) {
    renderEmpty({ reason: 'pdf.js 未能加载，请查看「输出 → XDOJ」日志。', sourceUrl: message.sourceUrl });
    return;
  }

  togglePdfToolbar(true);
  setStatus('解析中…');
  try {
    pdfController = await pdf.mount(host, {
      base64: message.base64,
      byteLength: message.byteLength,
    });
    setStatus('');
  } catch (error) {
    console.error('[xdoj] PDF 渲染失败', error);
    togglePdfToolbar(false);
    const reason = error instanceof Error ? error.message : String(error);
    contentEl.textContent = '';
    renderEmpty({ reason: `PDF 渲染失败：${reason}`, sourceUrl: message.sourceUrl });
    vscode.postMessage({ type: 'log', message: `PDF 渲染失败: ${reason}` });
  }
}

function renderText(message) {
  const pre = document.createElement('pre');
  pre.className = 'statement-text';
  pre.textContent = message.text ?? '';
  contentEl.appendChild(pre);
}

function renderHtml(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'statement-html';
  // 扩展侧已经摘掉 script/iframe，加上 CSP 限制，这里直接注入是安全的。
  wrapper.innerHTML = message.html ?? '';
  contentEl.appendChild(wrapper);
}

/** 统一渲染「这个文件没法在编辑器里预览，去本地打开」的卡片。 */
function renderFileCard(options) {
  const box = document.createElement('div');
  box.className = 'file-card';

  const ext = options.extension ? `.${options.extension}` : '该文件';
  box.innerHTML = `
    <h3>${escapeHtml(options.title)}</h3>
    <p>${options.messageHtml}</p>
    ${options.savedPath ? `<p class="path" title="${escapeHtml(options.savedPath)}">${escapeHtml(options.savedPath)}</p>` : ''}
    <p class="muted">${escapeHtml(options.footnote ?? '')}</p>
  `;

  const actions = document.createElement('div');
  actions.className = 'file-card-actions';

  if (options.savedPath) {
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'primary';
    openButton.textContent = '用系统程序打开';
    openButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'openLocalFile', path: options.savedPath }),
    );
    actions.appendChild(openButton);

    const revealButton = document.createElement('button');
    revealButton.type = 'button';
    revealButton.textContent = '在文件夹中显示';
    revealButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'revealInFolder', path: options.savedPath }),
    );
    actions.appendChild(revealButton);
  } else {
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'primary';
    downloadButton.textContent = '下载并打开';
    downloadButton.addEventListener('click', () => vscode.postMessage({ type: 'openDocxExternally' }));
    actions.appendChild(downloadButton);
  }

  if (options.sourceUrl) {
    const browserButton = document.createElement('button');
    browserButton.type = 'button';
    browserButton.textContent = '在浏览器中打开';
    browserButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'openExternal', url: options.sourceUrl }),
    );
    actions.appendChild(browserButton);
  }

  box.appendChild(actions);
  void ext;
  contentEl.textContent = '';
  contentEl.appendChild(box);
}

function renderBinary(message) {
  const ext = message.extension ? `.${message.extension}` : '这种格式';
  renderFileCard({
    title: '这个文件没法在编辑器里预览',
    messageHtml: `服务端返回的是 <code>${escapeHtml(ext)}</code> 文件，VS Code 里渲染不了它。`,
    extension: message.extension,
    savedPath: message.savedPath,
    sourceUrl: message.savedPath ? undefined : message.sourceUrl,
    footnote: message.savedPath ? '' : '文件也没能存到本地，可以直接从浏览器下载。',
  });
}

function renderDocx(message) {
  const publicUrl = message.publicUrl;
  const canEmbed =
    message.mode === 'office-online' && typeof publicUrl === 'string' && /^https?:/i.test(publicUrl);

  if (!canEmbed) {
    const reason =
      message.mode === 'download'
        ? '按当前设置，DOCX 题面不做在线预览，直接下载到本地打开。'
        : '该题面没有可用于在线预览的公网地址（这个接口需要登录态，微软的预览服务抓不到文件）。';
    renderFileCard({
      title: 'DOCX 题面已下载',
      messageHtml: escapeHtml(reason),
      extension: message.extension ?? 'docx',
      savedPath: message.savedPath,
      sourceUrl: message.savedPath ? undefined : message.sourceUrl,
      footnote: message.savedPath ? '' : '文件也没能存到本地，可以直接从浏览器下载。',
    });
    return;
  }

  const frame = document.createElement('iframe');
  frame.className = 'docx-frame';
  frame.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}`;
  frame.referrerPolicy = 'no-referrer';
  contentEl.classList.add('no-padding');
  contentEl.appendChild(frame);

  const note = document.createElement('div');
  note.className = 'docx-fallback';
  note.innerHTML = `
    <h3>预览空白？</h3>
    <p>Office 在线预览要求该文件能被公网匿名访问。带登录态的 OJ 附件通常抓不到，
       这时请改用下面的方式查看。</p>
  `;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = message.savedPath ? '用系统程序打开' : '下载并打开';
  button.addEventListener('click', () => {
    if (message.savedPath) {
      vscode.postMessage({ type: 'openLocalFile', path: message.savedPath });
    } else {
      vscode.postMessage({ type: 'openDocxExternally' });
    }
  });
  note.appendChild(button);

  const spacer = document.createElement('div');
  spacer.style.height = '24px';
  contentEl.appendChild(spacer);
  contentEl.appendChild(note);
}

function renderEmpty(message) {
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.innerHTML = `
    <h3>无法渲染题面</h3>
    <p class="reason">${escapeHtml(message.reason ?? '未知原因')}</p>
    ${message.sourceUrl ? `<p class="reason">${escapeHtml(message.sourceUrl)}</p>` : ''}
  `;

  if (message.sourceUrl) {
    const browserButton = document.createElement('button');
    browserButton.type = 'button';
    browserButton.textContent = '在浏览器中打开';
    browserButton.addEventListener('click', () =>
      vscode.postMessage({ type: 'openExternal', url: message.sourceUrl }),
    );
    box.appendChild(browserButton);
  }

  contentEl.textContent = '';
  contentEl.appendChild(box);
}

toolbarActions?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  switch (target.dataset.action) {
    case 'reload':
      setStatus('重新加载中…');
      vscode.postMessage({ type: 'reload' });
      break;
    case 'copy-url':
      if (currentSourceUrl) {
        vscode.postMessage({ type: 'copyUrl', url: currentSourceUrl });
      }
      break;
    case 'open-external':
      if (currentSourceUrl) {
        vscode.postMessage({ type: 'openExternal', url: currentSourceUrl });
      }
      break;
    case 'open-local':
      if (currentSavedPath) {
        vscode.postMessage({ type: 'openLocalFile', path: currentSavedPath });
      }
      break;
    case 'submit':
      vscode.postMessage({ type: 'submit' });
      break;
    default:
      break;
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'content') {
    void render(message);
  }
});

window.addEventListener('error', (event) => {
  vscode.postMessage({ type: 'log', message: `webview 未捕获错误: ${event.message}` });
});

vscode.postMessage({ type: 'ready' });
