import { create } from 'zustand';
import type { ServerMessage, WorkTask, WorkTaskSummary } from '@arena/shared';
import { api, errorMessage, type CreateWorkTaskInput } from '../api';
import { errorText } from '../errors';

interface WorkBoard {
  tasks: WorkTaskSummary[];
  selected: string | null;
  detail: WorkTask | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  connect(): () => void;
  select(id: string): Promise<void>;
  create(input: CreateWorkTaskInput): Promise<void>;
  review(decision: 'approve' | 'rework', summary: string, findings?: string): Promise<void>;
  approve(): Promise<void>;
  takeover(reason: string): Promise<void>;
}

function upsert(tasks: WorkTaskSummary[], task: WorkTask): WorkTaskSummary[] {
  if (tasks.some((entry) => entry.id === task.id && entry.updatedAt > task.updatedAt)) return tasks;
  return [...tasks.filter((entry) => entry.id !== task.id), {
    id: task.id, title: task.title, status: task.status, branch: task.branch,
    activeRound: task.activeRound, coordinatorName: task.coordinator.name,
    workerName: task.worker.name, updatedAt: task.updatedAt,
  }].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const useWorkStore = create<WorkBoard>((set, get) => {
  let selection = 0;
  const apply = (task: WorkTask) => set((state) => ({
    tasks: upsert(state.tasks, task),
    detail: state.selected === task.id && (!state.detail || state.detail.updatedAt <= task.updatedAt)
      ? task : state.detail,
  }));
  const mutate = async (action: (id: string) => Promise<WorkTask>) => {
    const { selected, busy } = get();
    if (!selected || busy) return;
    set({ busy: true, error: null });
    try { apply(await action(selected)); }
    catch (error) { set({ error: errorMessage(error) }); }
    finally { set({ busy: false }); }
  };
  return {
    tasks: [], selected: null, detail: null, loading: true, busy: false, error: null,
    async select(id) {
      const turn = ++selection;
      if (get().selected !== id) set({ selected: id, detail: null, error: null });
      try {
        const task = await api.workTask(id);
        if (turn === selection) apply(task);
      } catch (error) {
        if (turn === selection) set({ error: errorMessage(error) });
      }
    },
    approve: () => mutate(api.approveWorkMerge),
    takeover: (reason) => mutate((id) => api.takeOverWork(id, reason)),
    async create(input) {
      if (get().busy) return;
      set({ busy: true, error: null });
      try {
        const task = await api.createWorkTask(input);
        set({ selected: task.id, detail: task });
        apply(task);
      } catch (error) {
        set({ error: errorMessage(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },
    async review(decision, summary, findings) {
      const { selected, busy } = get();
      if (!selected || busy) return;
      set({ busy: true, error: null });
      try {
        apply(await api.reviewWorkTask(selected, { decision, summary, ...(findings === undefined ? {} : { findings }) }));
      } catch (error) {
        set({ error: errorMessage(error) });
        throw error;
      } finally {
        set({ busy: false });
      }
    },
    connect() {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let socket: WebSocket | undefined;
      const address = new URL('/ws?kind=work', window.location.href);
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      const load = (tasks: WorkTaskSummary[]) => {
        if (closed) return;
        const selected = tasks.find((task) => task.id === get().selected)?.id ?? tasks[0]?.id;
        set({ tasks, loading: false, error: null });
        if (selected) void get().select(selected);
        else set({ selected: null, detail: null });
      };
      const open = () => {
        socket = new WebSocket(address);
        socket.onmessage = ({ data }) => {
          if (closed) return;
          let frame: ServerMessage;
          try { frame = JSON.parse(data); }
          catch { return; }
          if (typeof frame !== 'object' || frame === null || !('kind' in frame) || frame.kind !== 'work') return;
          if (frame.type === 'hello') load(frame.tasks);
          if (frame.type === 'task') {
            apply(frame.task);
            if (!get().selected) set({ selected: frame.task.id, detail: frame.task });
          }
          if (frame.type === 'error') set({ loading: false, error: errorText(frame.code, frame.message) });
        };
        socket.onclose = ({ code }) => {
          if (closed || code === 1008) return;
          set({ error: '连接已断开，正在重连。' });
          timer = setTimeout(open, 1500);
        };
      };
      open();
      return () => {
        closed = true;
        selection++;
        clearTimeout(timer);
        socket?.close();
      };
    },
  };
});
