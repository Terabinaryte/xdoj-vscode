import * as vscode from 'vscode';

type Level = 'info' | 'warn' | 'error';

const CHANNEL_NAME = 'XDOJ';

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(subscriptions: { push(...items: vscode.Disposable[]): unknown }): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
  subscriptions.push(channel);
  return channel;
}

export function getLogger(): vscode.LogOutputChannel {
  if (!channel) {
    throw new Error('logger 尚未初始化');
  }
  return channel;
}

function write(level: Level, message: string, ...rest: unknown[]): void {
  if (!channel) {
    return;
  }
  const suffix = rest.length > 0 ? ` ${rest.map(stringify).join(' ')}` : '';
  channel[level](`${message}${suffix}`);
}

function stringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, ...rest: unknown[]) => write('info', message, ...rest),
  warn: (message: string, ...rest: unknown[]) => write('warn', message, ...rest),
  error: (message: string, ...rest: unknown[]) => write('error', message, ...rest),
  show: () => channel?.show(true),
};

/** 把可能泄漏 token 的请求头打码后再记录。 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|x-csrf-token|token)$/i.test(key) ? '***' : value;
  }
  return out;
}
