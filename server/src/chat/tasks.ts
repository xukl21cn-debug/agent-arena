import { z } from 'zod';
import { ChatError, chatMessageId, type ChatMember } from './model.js';

const memberSchema = z.object({ id: z.string(), name: z.string() });
const taskSchema = z.object({
  id: z.uuid(),
  from: memberSchema,
  to: memberSchema,
  prompt: z.string(),
  requestId: z.string().optional(),
  assignedAt: z.string(),
  claimedAt: z.string().optional(),
  result: z.object({ text: z.string(), at: z.string() }).optional(),
});

export type ChatTask = z.infer<typeof taskSchema>;

type TaskDelivery =
  | { reason: 'assigned' | 'in_progress' | 'result'; task: ChatTask }
  | { reason: 'timeout' | 'closed'; task: null };

/** The room owns task persistence. Work has no dependency on chat turns. */
export class ChatTasks {
  private readonly tasks = new Map<string, ChatTask>();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly persist: () => void) {}

  serialize(): ChatTask[] {
    return [...this.tasks.values()];
  }

  restore(value: unknown): void {
    for (const task of taskSchema.array().parse(value)) this.tasks.set(task.id, task);
  }

  wake(): void {
    for (const notify of [...this.waiters]) notify();
  }

  private save(task: ChatTask): ChatTask {
    const previous = this.tasks.get(task.id);
    this.tasks.set(task.id, task);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.tasks.set(task.id, previous);
      else this.tasks.delete(task.id);
      throw error;
    }
    return task;
  }

  assign(from: ChatMember, to: ChatMember, prompt: string, requestId?: string): ChatTask {
    if (from.id === to.id) throw new ChatError('INVALID_REQUEST', '请把任务交给另一位成员。');
    if (requestId !== undefined) {
      const existing = this.serialize().find((task) => task.from.id === from.id && task.requestId === requestId);
      if (existing) {
        if (existing.to.id === to.id && existing.prompt === prompt) return existing;
        throw new ChatError('INVALID_REQUEST', '这个请求编号已用于另一项任务。');
      }
    }
    const task = this.save({
      id: chatMessageId(),
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      prompt,
      requestId,
      assignedAt: new Date().toISOString(),
    });
    this.wake();
    return task;
  }

  get(id: string, memberId: string): ChatTask {
    const task = this.tasks.get(id);
    if (!task || (task.from.id !== memberId && task.to.id !== memberId)) {
      throw new ChatError('TASK_NOT_FOUND', '找不到这个任务。');
    }
    return task;
  }

  submit(id: string, memberId: string, text: string): ChatTask {
    const task = this.get(id, memberId);
    if (task.to.id !== memberId || !task.claimedAt) {
      throw new ChatError('INVALID_REQUEST', '请由领取任务的成员提交回报。');
    }
    if (task.result) {
      if (task.result.text === text) return task;
      throw new ChatError('INVALID_REQUEST', '这项任务已经回报。');
    }
    const completed = this.save({ ...task, result: { text, at: new Date().toISOString() } });
    this.wake();
    return completed;
  }

  private read(memberId: string, closed: boolean, taskId?: string): TaskDelivery | undefined {
    if (taskId !== undefined) {
      const task = this.get(taskId, memberId);
      if (task.result) return { reason: 'result', task };
    }
    if (closed) return { reason: 'closed', task: null };
    if (taskId !== undefined) return;

    let queued: ChatTask | undefined;
    for (const task of this.tasks.values()) {
      if (task.to.id !== memberId || task.result) continue;
      if (task.claimedAt) return { reason: 'in_progress', task };
      queued ??= task;
    }
    if (queued) {
      const task = this.save({ ...queued, claimedAt: new Date().toISOString() });
      return { reason: 'assigned', task };
    }
  }

  async wait(
    member: () => { id: string; closed: boolean },
    timeoutMs: number,
    signal: AbortSignal,
    taskId?: string,
  ): Promise<TaskDelivery> {
    const read = (): TaskDelivery | undefined => {
      if (signal.aborted) return { reason: 'timeout', task: null };
      const { id, closed } = member();
      return this.read(id, closed, taskId);
    };
    const immediate = read();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const clear = (): void => {
        this.waiters.delete(notify);
        clearTimeout(timer);
        signal.removeEventListener('abort', expire);
      };
      const expire = (): void => {
        clear();
        resolve({ reason: 'timeout', task: null });
      };
      const notify = (): void => {
        try {
          const ready = read();
          if (ready) {
            clear();
            resolve(ready);
          }
        } catch (error) {
          clear();
          reject(error);
        }
      };
      const timer = setTimeout(expire, timeoutMs);
      this.waiters.add(notify);
      signal.addEventListener('abort', expire, { once: true });
    });
  }
}
