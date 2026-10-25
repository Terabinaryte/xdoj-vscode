// pdf.js 查看器。以 ES module 形式加载，向 window.XdojPdf 暴露 mount()。
//
// 为什么不用 pdfjs-dist 自带的 web/ 查看器：那套 UI 依赖完整的 viewer 组件树和
// 一堆 CSS，塞进 VS Code webview 又大又容易和主题打架。题面 PDF 通常只有几页，
// 自己把每页画到 canvas 上反而更稳。
//
// 另一个坑是 Worker：webview 主文档来自 vscode-webview:// 而静态资源来自
// https://*.vscode-cdn.net，跨源直接 new Worker() 会被拒。所以先把 worker 脚本
// 取回来做成 blob URL —— blob: 是同源的。

/** @type {Promise<any> | undefined} */
let pdfjsPromise;

function assetUrl(relative) {
  return new URL(relative, import.meta.url).href;
}

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import(assetUrl('./vendor/pdfjs/pdf.min.mjs'));

      let workerSrc = assetUrl('./vendor/pdfjs/pdf.worker.min.mjs');
      try {
        const response = await fetch(workerSrc);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const source = await response.text();
        workerSrc = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      } catch (error) {
        // 退回直接引用资源 URL，pdf.js 还有主线程 fake worker 兜底。
        console.warn('[xdoj] 无法为 pdf.js worker 创建 blob，退回直连资源地址', error);
      }

      lib.GlobalWorkerOptions.workerSrc = workerSrc;
      return lib;
    })();
  }
  return pdfjsPromise;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 在 container 里渲染一份 PDF。
 * @param {HTMLElement} container
 * @param {{ base64: string, byteLength?: number }} payload
 */
export async function mountPdfViewer(container, payload) {
  const pdfjsLib = await loadPdfjs();
  const data = base64ToBytes(payload.base64);

  const base = new URL('./vendor/pdfjs/', import.meta.url).href;
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    // 安全：PDF 里可以内嵌 JavaScript（表单/动作），默认是开启的。
    // 题面来自外部服务端，不该让 PDF 里的脚本在 webview 里跑
    // （GHSA-hq66-cqwq-w95j，CVE-2026-16633）。
    enableScripting: false,
    enableXfa: false,
    // 同理，禁用 eval 系路径。
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  const state = {
    scale: 1,
    fitWidth: true,
    continuous: true,
    page: 1,
    rendering: false,
    pending: false,
    naturalWidth: 0,
  };

  container.textContent = '';
  const scroller = document.createElement('div');
  scroller.className = 'pdf-container';
  container.appendChild(scroller);

  /** @type {HTMLElement[]} */
  const pageNodes = [];

  // ---- 工具条 ----
  const toolbar = document.getElementById('pdf-toolbar');
  const pageInput = /** @type {HTMLInputElement | null} */ (document.getElementById('pdf-page'));
  const pagesLabel = document.getElementById('pdf-pages');
  const zoomLabel = document.getElementById('pdf-zoom');
  const scrollToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('pdf-scroll'));

  if (toolbar) {
    toolbar.hidden = false;
  }
  if (pagesLabel) {
    pagesLabel.textContent = String(doc.numPages);
  }
  if (pageInput) {
    pageInput.max = String(doc.numPages);
  }
  if (scrollToggle) {
    state.continuous = scrollToggle.checked;
  }

  // 先用第一页的原始宽度算出「适应宽度」对应的缩放比例。
  const firstPage = await doc.getPage(1);
  const natural = firstPage.getViewport({ scale: 1 });
  state.naturalWidth = natural.width;

  function computeFitScale() {
    const available = Math.max(320, container.clientWidth - 48);
    return Math.min(3, Math.max(0.2, available / state.naturalWidth));
  }

  function effectiveScale() {
    return state.fitWidth ? computeFitScale() : state.scale;
  }

  function updateZoomLabel() {
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(effectiveScale() * 100)}%`;
    }
  }

  async function renderAll() {
    if (state.rendering) {
      state.pending = true;
      return;
    }
    state.rendering = true;
    try {
      const scale = effectiveScale();
      const dpr = window.devicePixelRatio || 1;
      scroller.textContent = '';
      pageNodes.length = 0;

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = pageNumber === 1 ? firstPage : await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page';
        wrapper.dataset.page = String(pageNumber);

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        wrapper.appendChild(canvas);

        const badge = document.createElement('span');
        badge.className = 'pdf-page-number';
        badge.textContent = `${pageNumber} / ${doc.numPages}`;
        wrapper.appendChild(badge);

        scroller.appendChild(wrapper);
        pageNodes.push(wrapper);

        // canvas 参数是 pdf.js 5 的推荐写法，canvasContext 已降级为兼容选项。
        await page.render({
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        }).promise;
      }
      applyPaging();
      updateZoomLabel();
    } finally {
      state.rendering = false;
      if (state.pending) {
        state.pending = false;
        void renderAll();
      }
    }
  }

  function applyPaging() {
    pageNodes.forEach((node, index) => {
      node.classList.toggle('single-hidden', !state.continuous && index + 1 !== state.page);
    });
    if (pageInput) {
      pageInput.value = String(state.page);
    }
  }

  function gotoPage(pageNumber) {
    const target = Math.min(Math.max(1, Math.round(pageNumber)), doc.numPages);
    state.page = target;
    applyPaging();
    const node = pageNodes[target - 1];
    if (node && !state.continuous) {
      node.scrollIntoView({ block: 'start' });
    } else if (node && state.continuous) {
      node.scrollIntoView({ block: 'start' });
    }
  }

  // 连续滚动时，用滚动位置反推当前页号，让页码框跟着走。
  container.addEventListener(
    'scroll',
    () => {
      if (!state.continuous) {
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      let current = 1;
      for (const node of pageNodes) {
        if (node.getBoundingClientRect().top - containerTop <= 40) {
          current = Number(node.dataset.page ?? '1');
        } else {
          break;
        }
      }
      state.page = current;
      if (pageInput && document.activeElement !== pageInput) {
        pageInput.value = String(current);
      }
    },
    { passive: true },
  );

  let resizeTimer;
  const onResize = () => {
    if (!state.fitWidth) {
      return;
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderAll(), 160);
  };
  window.addEventListener('resize', onResize);

  toolbar?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    switch (target.dataset.pdf) {
      case 'prev':
        gotoPage(state.page - 1);
        break;
      case 'next':
        gotoPage(state.page + 1);
        break;
      case 'zoom-in':
        state.scale = Math.min(4, effectiveScale() * 1.2);
        state.fitWidth = false;
        void renderAll();
        break;
      case 'zoom-out':
        state.scale = Math.max(0.2, effectiveScale() / 1.2);
        state.fitWidth = false;
        void renderAll();
        break;
      case 'fit-width':
        state.fitWidth = true;
        void renderAll();
        break;
      default:
        break;
    }
  });

  pageInput?.addEventListener('change', () => {
    gotoPage(Number(pageInput.value) || 1);
  });

  scrollToggle?.addEventListener('change', () => {
    state.continuous = !!scrollToggle.checked;
    applyPaging();
  });

  await renderAll();
  return {
    destroy() {
      window.removeEventListener('resize', onResize);
      // pdf.js 6 起 PDFDocumentProxy.destroy() 被去掉，改由 loadingTask 统一销毁。
      void loadingTask.destroy();
    },
  };
}

window.XdojPdf = { mount: mountPdfViewer };
