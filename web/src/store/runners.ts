import { create } from 'zustand';
import type { RunnerDetail, RunnerSummary } from '@arena/shared';
import { api, errorMessage } from '../api';
import { errorText } from '../errors';

interface RunnerBoard {
  runners: RunnerSummary[];
  selected: string | null;
  detail: RunnerDetail | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  connect(): () => void;
  select(id: string): Promise<void>;
  cancel(): Promise<void>;
}

function summaryOf(detail: RunnerDetail): RunnerSummary {
  const { events: _events, ...summary } = detail;
  return summary;
}

function upsert(runners: RunnerSummary[], next: RunnerSummary): RunnerSummary[] {
  return [...runners.filter((runner) => runner.id !== next.id), next].sort(
    (a, b) => a.registeredAt - b.registeredAt || a.id.localeCompare(b.id),
  );
}

export const useRunnerStore = create<RunnerBoard>((set, get) => {
  let selection = 0;
  const apply = (detail: RunnerDetail) => set((state) => {
    const summary = summaryOf(detail);
    return {
      runners: upsert(state.runners, summary),
      detail: state.selected === detail.id ? detail : state.detail,
    };
  });
  return {
    runners: [], selected: null, detail: null, loading: true, busy: false, error: null, notice: null,
    async select(id) {
      const turn = ++selection;
      set({ selected: id, notice: null });
      try {
        const detail = await api.runnerDetail(id);
        if (turn === selection) apply(detail);
      } catch (error) {
        if (turn === selection) set({ error: errorMessage(error) });
      }
    },
    async cancel() {
      const { selected, detail, busy } = get();
      if (!selected || busy) return;
      set({ busy: true, error: null, notice: null });
      try {
        await api.runnerCommand(selected, 'cancel', detail?.currentTask?.id);
        set({ notice: '取消命令已排队：runner 在线时会立即收到，离线时会在重连后收到。' });
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ busy: false });
      }
    },
    connect() {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let socket: WebSocket | undefined;
      const address = new URL('/ws?kind=runner', window.location.href);
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      const load = (runners: RunnerSummary[]) => {
        if (closed) return;
        const selected = runners.find((runner) => runner.id === get().selected)?.id ?? runners[0]?.id;
        set({ runners, loading: false, error: null, selected: selected ?? null });
        if (selected) void get().select(selected);
        else set({ detail: null });
      };
      const open = () => {
        socket = new WebSocket(address);
        socket.onmessage = ({ data }) => {
          if (closed) return;
          let frame: unknown;
          try { frame = JSON.parse(data); }
          catch { return; }
          if (typeof frame !== 'object' || frame === null || !('kind' in frame) || frame.kind !== 'runner') return;
          const message = frame as unknown as { type: string; runners?: RunnerSummary[]; runner?: RunnerDetail; code?: string; message?: string };
          if (message.type === 'hello' && message.runners) load(message.runners);
          if (message.type === 'runner' && message.runner) apply(message.runner);
          if (message.type === 'error') set({ loading: false, error: errorText(message.code ?? 'INTERNAL_ERROR', message.message ?? 'Runner 连接失败。') });
        };
        socket.onclose = ({ code }) => {
          if (closed || code === 1008) return;
          set({ error: 'Runner 连接已断开，正在重连。' });
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
