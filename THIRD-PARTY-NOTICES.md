# 第三方组件与许可

本扩展以 **MIT** 发布（见 [LICENSE](LICENSE)）。它附带下列第三方组件，
这些组件**不会**改变本扩展的许可，但需要保留各自的版权与许可声明。

## pdf.js（`pdfjs-dist`）

| 项 | 内容 |
| --- | --- |
| 版本 | 6.4.299 |
| 许可 | Apache License 2.0 |
| 用途 | 在题面标签页里渲染 PDF |
| 分发方式 | 构建时由 [`scripts/copy-pdfjs.mjs`](scripts/copy-pdfjs.mjs) 把运行时资源复制进 `media/vendor/pdfjs/`，随扩展包一起分发 |
| 许可全文 | 随产物一起分发在 `media/vendor/pdfjs/LICENSE` |
| 上游 | https://github.com/mozilla/pdf.js |

用到的资源：`pdf.min.mjs`、`pdf.worker.min.mjs`、`standard_fonts/`、`cmaps/`、
`wasm/`、`iccs/`。扩展只调用它公开的渲染 API，未修改其源码。

> Apache-2.0 要求保留版权声明与许可文本 —— 因此 `media/vendor/pdfjs/LICENSE`
> **必须**保留在扩展包里，不要把它加进 `.vscodeignore`。

## VS Code API（`@types/vscode`）

仅用于类型检查，不随扩展分发，遵循其自身的 MIT 许可。

## 开发期依赖

`@vscode/vsce`、`typescript`、`@types/node` 等只在开发和打包时使用，
不进入最终产物。

## 与 XDOJ 的关系

本项目是**非官方的第三方客户端**，与 XDOJ 及其运维方没有隶属关系，
也未获得其背书。它只是按公开可观察到的 HTTP 接口行为工作。
使用前请自行确认所在学校/平台的使用条款，并自行承担账号与使用风险。
