import { z } from 'zod';
import { compareChatTimeline, type ChatTaskEventFrame } from '@arena/shared';
import { ChatError, chatMessageId, type ChatMember } from './model.js';

const memberSchema = z.object({ id: z.string(), name: z.string() });
const taskActions = z.enum(['assigned', 'claimed', 'reported', 'finished', 'acknowledged']);
const taskSchema = z.object({
  id: z.uuid(),
  from: memberSchema,
  to: memberSchema,
  prompt: z.string(),
  requestId: z.string().optional(),
  assignedAt: z.string(),
  claimedAt: z.string().optional(),
  result: z.object({ text: z.string(), at: z.string() }).optional(),
  finished: z.object({
    at: z.string(),
    note: z.string().optional(),
    acknowledgedAt: z.string().optional(),
  }).optional(),
  timeline: z.partialRecord(taskActions, z.number().int().positive()).optional(),
});

export type ChatTask = z.infer<typeof taskSchema>;

type TaskDelivery =
  | { reason: 'assigned' | 'in_progress' | 'result' | 'finished'; task: ChatTask }
  | { reason: 'timeout' | 'closed'; task: null };

function taskEvents(task: ChatTask): ChatTaskEventFrame[] {
  const events: ChatTaskEventFrame[] = [];
  const add = (
    action: ChatTaskEventFrame['action'],
    at: string | undefined,
    fromName: string,
    toName: string,
    text?: string,
  ): void => {
    if (!at) return;
    const timelineOrder = task.timeline?.[action];
    events.push({
      taskId: task.id,
      action,
      fromName,
      toName,
      at,
      ...(text === undefined ? {} : { text }),
      ...(timelineOrder === undefined ? {} : { timelineOrder }),
    });
  };
  const origin = task.from.name;
  const worker = task.to.name;
  add('assigned', task.assignedAt, origin, worker, task.prompt);
  add('claimed', task.claimedAt, worker, origin);
  add('reported', task.result?.at, worker, origin, task.result?.text);
  add('finished', task.finished?.at, origin, worker, task.finished?.note);
  add('acknowledged', task.finished?.acknowledgedAt, worker, origin);
  return events;
}

/** The room owns task persistence. Work has no dependency on chat turns. */
export class ChatTasks {
  private readonly tasks = new Map<string, ChatTask>();
  private readonly waiters = new Set<() => void>();
  private readonly eventListeners = new Set<(event: ChatTaskEventFrame) => void>();

  constructor(
    private readonly persist: () => void,
    private readonly nextTimelineOrder: () => number,
  ) {}

  serialize(): ChatTask[] {
    return [...this.tasks.values()];
  }

  restore(value: unknown): number {
    let lastOrder = 0;
    for (const task of taskSchema.array().parse(value)) {
      this.tasks.set(task.id, task);
      for (const order of Object.values(task.timeline ?? {})) {
        lastOrder = Math.max(lastOrder, order ?? 0);
      }
    }
    return lastOrder;
  }

  recentEvents(limit: number): ChatTaskEventFrame[] {
    return this.serialize().flatMap(taskEvents).sort(compareChatTimeline).slice(-limit);
  }

  subscribeEvents(listener: (event: ChatTaskEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  wake(): void {
    for (const notify of [...this.waiters]) notify();
  }

  private save(task: ChatTask, action: ChatTaskEventFrame['action']): ChatTask {
    const updated = {
      ...task,
      timeline: { ...task.timeline, [action]: this.nextTimelineOrder() },
    };
    const previous = this.tasks.get(task.id);
    this.tasks.set(task.id, updated);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.tasks.set(task.id, previous);
      else this.tasks.delete(task.id);
      throw error;
    }
    const event = taskEvents(updated).find((item) => item.action === action);
    if (event) {
      for (const listener of this.eventListeners) listener(event);
    }
    return updated;
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
    }, 'assigned');
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
    const completed = this.save({ ...task, result: { text, at: new Date().toISOString() } }, 'reported');
    this.wake();
    return completed;
  }

  finish(id: string, memberId: string, note?: string): ChatTask {
    const task = this.get(id, memberId);
    if (task.from.id !== memberId || !task.result) {
      throw new ChatError('INVALID_REQUEST', '请由派单成员复核回报后结束任务。');
    }
    if (task.finished) return task;
    const finished = this.save({ ...task, finished: { at: new Date().toISOString(), note } }, 'finished');
    this.wake();
    return finished;
  }

  acknowledge(id: string, memberId: string): ChatTask {
    const task = this.get(id, memberId);
    if (task.to.id !== memberId || !task.finished) {
      throw new ChatError('INVALID_REQUEST', '请由工作成员确认已结束的任务。');
    }
    if (task.finished.acknowledgedAt) return task;
    return this.save({
      ...task,
      finished: { ...task.finished, acknowledgedAt: new Date().toISOString() },
    }, 'acknowledged');
  }

  private read(memberId: string, closed: boolean, taskId?: string): TaskDelivery | undefined {
    if (taskId !== undefined) {
      const task = this.get(taskId, memberId);
      if (task.from.id === memberId && task.result) return { reason: 'result', task };
      if (task.to.id === memberId && task.finished) return { reason: 'finished', task };
    } else {
      for (const task of this.tasks.values()) {
        if (task.to.id === memberId && task.finished && !task.finished.acknowledgedAt) {
          return { reason: 'finished', task };
        }
      }
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
      const task = this.save({ ...queued, claimedAt: new Date().toISOString() }, 'claimed');
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
