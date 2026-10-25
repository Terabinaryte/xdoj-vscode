#!/usr/bin/env python3
"""
XDOJ 请求转储服务器 —— 用来抓 VS Code 扩展实际发出的原始请求。

为什么需要它：扩展走 Node 的 fetch（undici），会自己塞一些删不掉的头
（accept-encoding、sec-fetch-mode），也可能复用 TCP 连接。这些在扩展日志里
看不全。把扩展指到这个服务器上，就能看到逐字节的真相。

两种模式
--------
mock  完全离线。返回构造好的假响应，让扩展能走完
      登录 → 比赛列表 → 比赛题目 → 题面 → 提交记录 → 提交 全流程。

proxy 把请求**原样**转发给真实 XDOJ 并 dump 头。扩展照常工作，
      但你能抓到它的原始请求，和浏览器/curl 的逐条对比。

用法
----
    python3 tools/dump_server.py --mode mock  --port 8080
    python3 tools/dump_server.py --mode proxy --port 8080 \
        --upstream https://your-oj.example

然后把扩展设置改成：

    "xdoj.endpoint": "http://127.0.0.1:8080",
    "xdoj.useMockData": false

注意：proxy 模式会把 Cookie 原样转发，日志里也会打印（这是排查必需的）。
日志文件默认写在 ./dump_requests.log，别外传。
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# --------------------------------------------------------------------------- 日志

LOG_LOCK = threading.Lock()
REQUEST_SEQ = 0
LOG_FILE = None
START_TIME = time.monotonic()
LAST_REQUEST_AT = None

# 想快速 diff 两次运行的头部名单，就打开这个：每个请求额外打一行头名序列
PRINT_HEADER_NAMES = True


def emit(text: str = "") -> None:
    with LOG_LOCK:
        print(text, flush=True)
        if LOG_FILE is not None:
            LOG_FILE.write(text + "\n")
            LOG_FILE.flush()


def next_seq() -> int:
    global REQUEST_SEQ
    with LOG_LOCK:
        REQUEST_SEQ += 1
        return REQUEST_SEQ


# ----------------------------------------------------------------------- 假响应

FAKE_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)

CONTEST_LIST = {
    "totalCount": 1,
    "totalpages": 1,
    "page": 1,
    "data": [
        {
            "active": True,
            "classes": [],
            "creatorId": "demo-teacher",
            "description": "dump server 假数据",
            "endTime": "2026-01-12 23:59:00",
            "id": "demo-contest",
            "judging": True,
            "problems": [],
            "running": True,
            "startTime": "2026-01-05 14:00:00",
            "started": True,
            "status": 1,
            "statusString": "Ready",
            "title": "示例比赛（进行中）",
            "type": 0,
        }
    ],
}

CONTEST_PROBLEMS = {
    "totalCount": 2,
    "totalpages": 1,
    "page": 1,
    "data": [
        {
            "categoryName": "基本计算",
            "difficulty": 1,
            "id": "demo-problem-a",
            "memoryLimit": 100,
            "orderId": 0,
            "tags": [{"id": "demo-tag", "name": "基本计算"}],
            "text": [],
            "textType": "",
            "timeLimit": 1,
            "title": "计算球体重量",
            "userAcceptCount": 1,
        },
        {
            "categoryName": "基本计算",
            "difficulty": 1,
            "id": "demo-problem-b",
            "memoryLimit": 100,
            "orderId": 1,
            "tags": [{"id": "demo-tag", "name": "基本计算"}],
            "text": [],
            "textType": "",
            "timeLimit": 1,
            "title": "温度转换",
            "userAcceptCount": 0,
        },
    ],
}

SUBMISSION_RESULTS = {
    "totalCount": 1,
    "totalpages": 1,
    "page": 1,
    "data": [
        {
            "contestId": "demo-contest",
            "id": "demo-submission-3",
            "judgement": 1,
            "judgementText": "正确",
            "language": {"id": 2, "name": "GNU C/C++"},
            "languageId": 2,
            "memory": 3,
            "points": 100.0,
            "problem": {"id": "demo-problem-b", "title": "温度转换"},
            "problemId": "demo-problem-b",
            "submitTime": "2026-01-06 19:35:57",
            "time": 42,
            "userId": "demo-account",
        }
    ],
}

SUBMIT_PAGE_HTML = """<!doctype html>
<html lang="zh"><body>
<form name="submit_form" action="/submission/submit.do" method="post" enctype="multipart/form-data">
  <input type="hidden" value="0" id="solutionType" name="solutionType" />
  <input type="hidden" value="demo-contest" id="contestId" name="contestId" />
  <input type="hidden" value="demo-account" id="userId" name="userId" />
  <input type="hidden" value="demo-class" id="classId" name="classId" />
  <input type="hidden" value="demo-problem-d" id="problemId" name="problemId" />
  <select id="languageId" name="languageId"><option value="2">GNU C/C++</option></select>
</form>
</body></html>
"""


def mock_response(path: str, body: bytes):
    """按路径后缀返回假响应：(status, headers, body)。"""
    if "downloadTextFile.do" in path:
        return 200, {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment;filename=statement.pdf",
        }, FAKE_PDF
    if path.endswith("/user/login.do") or "login.do" in path:
        return 200, {
            "Content-Type": "application/json;charset=UTF-8",
            "Content-Disposition": "attachment;filename=f.txt",
            "Set-Cookie": "JSESSIONID=DUMPFAKE1234567890; Path=/xdoj-ssm; HttpOnly",
        }, json.dumps({"error": 0, "userType": 0}).encode()
    if "team/submit.do" in path:
        return 200, {"Content-Type": "text/html;charset=UTF-8"}, SUBMIT_PAGE_HTML.encode()
    if "submission/submit.do" in path:
        return 200, {"Content-Type": "application/json;charset=UTF-8"}, json.dumps(
            {"code": 0, "info": "success"}
        ).encode()
    if "contest/problems.do" in path:
        return 200, {"Content-Type": "application/json;charset=UTF-8"}, json.dumps(
            CONTEST_PROBLEMS
        ).encode()
    if "contest/list.do" in path:
        return 200, {"Content-Type": "application/json;charset=UTF-8"}, json.dumps(
            CONTEST_LIST
        ).encode()
    if "submission/results.do" in path:
        return 200, {"Content-Type": "application/json;charset=UTF-8"}, json.dumps(
            SUBMISSION_RESULTS
        ).encode()
    if path.endswith(".do"):
        return 200, {"Content-Type": "text/html;charset=UTF-8"}, b"<html><body>dump</body></html>"
    return 200, {"Content-Type": "application/json;charset=UTF-8"}, b"{}"


# ------------------------------------------------------------------- 请求体解码


def read_body(handler) -> bytes:
    """读请求体，同时支持 Content-Length 和 chunked。"""
    encoding = (handler.headers.get("Transfer-Encoding") or "").lower()
    if "chunked" in encoding:
        chunks = []
        while True:
            line = handler.rfile.readline(65536).strip()
            if not line:
                break
            try:
                size = int(line.split(b";")[0], 16)
            except ValueError:
                break
            if size == 0:
                handler.rfile.readline(65536)  # 结尾的空行
                break
            chunks.append(handler.rfile.read(size))
            handler.rfile.read(2)  # CRLF
        return b"".join(chunks)

    length = handler.headers.get("Content-Length")
    if length and length.isdigit():
        return handler.rfile.read(int(length))
    return b""


def printable_body(raw: bytes, content_type: str) -> str:
    if not raw:
        return "(空)"
    head = raw[:4000]
    if any(t in content_type for t in ("json", "text", "x-www-form-urlencoded", "xml")):
        try:
            return head.decode("utf-8")
        except UnicodeDecodeError:
            pass
    # multipart 里其实也是文本，直接按 utf-8 尽力解码最好读
    try:
        text = head.decode("utf-8")
        if text.isprintable() or "\r\n" in text:
            return text.replace("\r\n", "\n")
    except UnicodeDecodeError:
        pass
    return f"<二进制 {len(raw)} 字节> {raw[:64].hex(' ')}"


# ------------------------------------------------------------------- 转发到真实


def forward_to_upstream(upstream: str, method: str, path: str, headers, body: bytes):
    """把请求原样转发给真实服务端，返回 (status, headers, body)。"""
    parts = urlsplit(upstream)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), timeout=30)

    fwd_headers = {}
    for name, value in headers.raw_items():
        lower = name.lower()
        # Host 由 http.client 根据连接重算；其余一律原样转发，保证"逐字节一致"
        if lower == "host":
            continue
        fwd_headers[name] = value

    try:
        conn.request(method, path, body=body or None, headers=fwd_headers)
        resp = conn.getresponse()
        payload = resp.read()
        out_headers = {}
        for name, value in resp.getheaders():
            if name.lower() in ("transfer-encoding", "content-length", "connection"):
                continue
            out_headers[name] = value
        return resp.status, out_headers, payload
    finally:
        conn.close()


# ------------------------------------------------------------------------ 处理器


class DumpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "XdojDumpServer/1.0"

    def log_message(self, *_args):  # 关掉默认日志
        pass

    # --- 所有方法都走同一个入口 ---
    def do_GET(self):
        self.handle_any()

    def do_POST(self):
        self.handle_any()

    def do_PUT(self):
        self.handle_any()

    def do_DELETE(self):
        self.handle_any()

    def do_HEAD(self):
        self.handle_any()

    def do_OPTIONS(self):
        self.handle_any()

    def handle_any(self):
        global LAST_REQUEST_AT
        seq = next_seq()
        now = dt.datetime.now()
        elapsed = (time.monotonic() - START_TIME) * 1000

        body = read_body(self)
        content_type = self.headers.get("Content-Type", "")

        # 同一条 TCP 连接上的第几个请求 —— 用来发现连接复用
        conn_id = self.client_address[1]
        gap = ""
        if LAST_REQUEST_AT is not None:
            gap = f"  （距上一个请求 {(now - LAST_REQUEST_AT).total_seconds():.3f}s）"
        LAST_REQUEST_AT = now

        lines = []
        lines.append("")
        lines.append("=" * 100)
        lines.append(f"[#{seq}] {now.strftime('%H:%M:%S.%f')[:-3]}   {self.command} {self.path}")
        lines.append(
            f"      来源 {self.client_address[0]}:{conn_id}   "
            f"HTTP/{self.request_version.split('/')[-1]}   启动后 +{elapsed:.0f}ms{gap}"
        )
        lines.append("-" * 100)
        lines.append("请求头（原样、含顺序与大小写）：")
        for name, value in self.headers.raw_items():
            lines.append(f"    {name}: {value}")
        lines.append("-" * 100)
        lines.append(f"请求体（{len(body)} 字节）：")
        for chunk in printable_body(body, content_type).splitlines() or ["(空)"]:
            lines.append(f"    {chunk}")

        # 一行版头名清单，方便 diff 两次运行
        if PRINT_HEADER_NAMES:
            names = ",".join(name for name, _ in self.headers.raw_items())
            lines.append("-" * 100)
            lines.append(f"头名序列: {names}")

        try:
            status, out_headers, payload = self.dispatch(body)
            lines.append("-" * 100)
            lines.append(f"响应 → HTTP {status}  {len(payload)} 字节")
        except Exception as exc:  # noqa: BLE001
            status, out_headers, payload = 502, {"Content-Type": "text/plain"}, str(exc).encode()
            lines.append("-" * 100)
            lines.append(f"转发失败：{exc!r}")

        emit("\n".join(lines))

        self.send_response(status)
        for name, value in out_headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def dispatch(self, body: bytes):
        if self.server.mode == "proxy":
            return forward_to_upstream(
                self.server.upstream, self.command, self.path, self.headers, body
            )
        return mock_response(self.path, body)


class DumpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    global LOG_FILE

    parser = argparse.ArgumentParser(description="转储扩展发出的原始 HTTP 请求")
    parser.add_argument("--mode", choices=("mock", "proxy"), default="mock")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--upstream",
        default=os.environ.get("XDOJ_UPSTREAM", ""),
        help="proxy 模式的上游地址（也可用环境变量 XDOJ_UPSTREAM），例如 https://your-oj.example",
    )
    parser.add_argument("--log", default="dump_requests.log", help="日志文件路径")
    args = parser.parse_args()

    if args.mode == "proxy" and not args.upstream:
        parser.error(
            "proxy 模式必须指定 --upstream（或设置 XDOJ_UPSTREAM），"
            "例如 --upstream https://your-oj.example"
        )

    LOG_FILE = open(args.log, "w", encoding="utf-8")

    server = DumpServer((args.host, args.port), DumpHandler)
    server.mode = args.mode
    server.upstream = args.upstream

    emit("=" * 100)
    emit(f"XDOJ 请求转储服务器   模式={args.mode}   监听 http://{args.host}:{args.port}")
    emit(f"上游 = {args.upstream}" if args.mode == "proxy" else "上游 = （mock，不转发）")
    emit(f"日志文件 = {args.log}")
    emit("=" * 100)
    emit("把扩展设置改成：")
    emit(f'    "xdoj.endpoint": "http://{args.host}:{args.port}",')
    emit('    "xdoj.useMockData": false')
    emit("=" * 100)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        emit("\n已停止。")
    finally:
        server.server_close()
        if LOG_FILE:
            LOG_FILE.close()
    return 0


if __name__ == "__main__":
    if sys.version_info < (3, 8):
        print("需要 Python 3.8+", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(main())
