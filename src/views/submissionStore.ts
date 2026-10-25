import * as vscode from 'vscode';
import type { Submission } from '../api/types';

/** 侧栏「提交记录」的数据源，负责去重、排序和变更通知。 */
export class SubmissionStore implements vscode.Disposable {
  private items: Submission[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  get all(): Submission[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  find(id: string): Submission | undefined {
    return this.items.find((item) => item.id === id);
  }

  replaceAll(list: Submission[]): void {
    this.items = dedupe(list);
    this.emitter.fire();
  }

  /** 新提交或状态更新。新记录会插到最前面。 */
  upsert(submission: Submission): void {
    const index = this.items.findIndex((item) => item.id === submission.id);
    if (index >= 0) {
      this.items = [...this.items];
      this.items[index] = { ...this.items[index], ...submission };
    } else {
      this.items = [submission, ...this.items];
    }
    this.emitter.fire();
  }

  /** 删掉一条（认领到真实提交 ID 后清掉本地占位记录）。 */
  remove(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) {
      return;
    }
    this.items = next;
    this.emitter.fire();
  }

  clear(): void {
    if (this.items.length === 0) {
      return;
    }
    this.items = [];
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function dedupe(list: Submission[]): Submission[] {
  const seen = new Map<string, Submission>();
  for (const item of list) {
    const previous = seen.get(item.id);
    seen.set(item.id, previous ? { ...previous, ...item } : item);
  }
  return [...seen.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
