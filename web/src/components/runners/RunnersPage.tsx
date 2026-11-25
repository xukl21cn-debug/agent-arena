import { useEffect } from 'react';
import { Activity, CircleAlert, Clock3, Radio, Server, Square, Terminal, WifiOff } from 'lucide-react';
import type { RunnerDetail, RunnerEvent, RunnerSummary } from '@arena/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRunnerStore } from '../../store/runners';
import { usePageTitle } from '../layout/PageTitle';
import { BackLink } from '../layout/BackLink';

const eventTone: Record<RunnerEvent['level'], string> = {
  info: 'text-muted-foreground',
  warn: 'text-[var(--gold-high)]',
  error: 'text-[var(--seal)]',
};

function StatusDot({ runner }: { runner: RunnerSummary }) {
  const executing = runner.status === 'online' && runner.currentTask !== null;
  return (
    <span
      className={`inline-block size-2 rounded-full ${
        runner.status === 'offline'
          ? 'bg-[var(--text-faint)]'
          : executing
            ? 'animate-pulse bg-[var(--gold)]'
            : 'bg-[var(--ok)]'
      }`}
      aria-hidden="true"
    />
  );
}

function StatusBadge({ runner }: { runner: RunnerSummary }) {
  if (runner.status === 'offline') return <Badge variant="outline"><WifiOff className="size-3" />离线</Badge>;
  if (runner.currentTask) return <Badge><Activity className="size-3" />执行中</Badge>;
  return <Badge variant="secondary">空闲</Badge>;
}

function SummaryStrip({ runners }: { runners: RunnerSummary[] }) {
  const online = runners.filter((runner) => runner.status === 'online').length;
  const executing = runners.filter((runner) => runner.currentTask !== null).length;
  const lastSeen = runners.reduce<number | null>((latest, runner) => (
    latest === null || runner.lastSeenAt > latest ? runner.lastSeenAt : latest
  ), null);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardDescription>在线执行器</CardDescription>
          <CardTitle className="text-2xl">{online} <span className="text-sm font-normal text-muted-foreground">/ {runners.length}</span></CardTitle>
        </CardHeader>
      </Card>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardDescription>正在执行</CardDescription>
          <CardTitle className="text-2xl">{executing}</CardTitle>
        </CardHeader>
      </Card>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardDescription>最近心跳</CardDescription>
          <CardTitle className="text-base font-medium">{lastSeen === null ? '—' : new Date(lastSeen).toLocaleTimeString('zh-CN')}</CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}

function RunnerList({ runners, selected, onSelect }: {
  runners: RunnerSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (runners.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
        <Terminal className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="font-medium">还没有 runner 注册</p>
        <p className="mt-1 text-sm text-muted-foreground">
          先在仓库根运行 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">pnpm runner -- --config runner.config.json</code>。
        </p>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>执行器</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>当前任务</TableHead>
          <TableHead>最近心跳</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runners.map((runner) => (
          <TableRow
            key={runner.id}
            className={`cursor-pointer ${runner.id === selected ? 'bg-muted/60' : ''}`}
            onClick={() => onSelect(runner.id)}
          >
            <TableCell>
              <div className="flex items-center gap-2">
                <StatusDot runner={runner} />
                <div>
                  <div className="font-medium">{runner.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{runner.id}</div>
                </div>
              </div>
            </TableCell>
            <TableCell><StatusBadge runner={runner} /></TableCell>
            <TableCell className="max-w-[16rem] truncate text-muted-foreground">
              {runner.currentTask?.title ?? '—'}
            </TableCell>
            <TableCell className="text-muted-foreground">{new Date(runner.lastSeenAt).toLocaleTimeString('zh-CN')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EventList({ events }: { events: RunnerEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">暂无事件。</p>;
  return (
    <ol className="max-h-80 space-y-3 overflow-y-auto pr-1">
      {[...events].reverse().map((event) => (
        <li key={event.seq} className="flex gap-3 text-xs">
          <span className="w-14 shrink-0 text-muted-foreground">{new Date(event.at).toLocaleTimeString('zh-CN')}</span>
          <span className={`min-w-0 break-words ${eventTone[event.level]}`}>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

function RunnerDetailPanel({ detail, busy, onCancel }: {
  detail: RunnerDetail;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="size-4 text-[var(--gold)]" />{detail.name}
            </CardTitle>
            <CardDescription className="mt-1 font-mono text-[11px]">{detail.id}</CardDescription>
          </div>
          <StatusBadge runner={detail} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">工作区</dt>
          <dd className="break-all font-mono">{detail.workspace}</dd>
          <dt className="text-muted-foreground">版本</dt>
          <dd className="font-mono">{detail.version}</dd>
          <dt className="text-muted-foreground">最近心跳</dt>
          <dd>{new Date(detail.lastSeenAt).toLocaleString('zh-CN')}</dd>
        </dl>
        <Separator />
        <section className="space-y-2" aria-label="当前任务">
          <h3 className="flex items-center gap-2 text-sm font-medium"><Radio className="size-3.5" />当前任务</h3>
          {detail.currentTask ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="font-medium">{detail.currentTask.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                第 {detail.currentTask.round} 轮 · {detail.currentTask.id}
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">空闲，等待任务。</p>}
        </section>
        <div>
          <Button variant="outline" type="button" disabled={busy || detail.currentTask === null} onClick={onCancel}>
            <Square className="size-3.5" />取消当前任务
          </Button>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3 shrink-0" />
            命令只会排队；runner 离线时会在下次重连后收到。
          </p>
        </div>
        <Separator />
        <section className="space-y-2" aria-label="最近事件">
          <h3 className="flex items-center gap-2 text-sm font-medium"><Clock3 className="size-3.5" />最近事件</h3>
          <EventList events={detail.events} />
        </section>
      </CardContent>
    </Card>
  );
}

export function RunnersPage() {
  usePageTitle('Runner 管理');
  const { runners, selected, detail, loading, busy, error, notice, connect, select, cancel } = useRunnerStore();
  useEffect(() => connect(), [connect]);

  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/" label="返回大厅" />
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Runner Registry</p>
          <h2 className="page-title">Runner 管理</h2>
          <p className="page-subtitle">本机执行器：在线状态、当前任务与最近事件。</p>
        </div>
      </div>
      {error && <p className="error-bar" role="alert">{error}</p>}
      {notice && <p className="mb-4 rounded-md border border-[var(--gold-border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--gold-high)]" role="status">{notice}</p>}
      {loading ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">正在连接 runner 注册表…</CardContent></Card>
      ) : (
        <div className="space-y-6">
          <SummaryStrip runners={runners} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.8fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">执行器</CardTitle>
                <CardDescription>状态来自 runner 的注册与心跳；离线实例仍可接收排队命令。</CardDescription>
              </CardHeader>
              <CardContent>
                <RunnerList runners={runners} selected={selected} onSelect={(id) => void select(id)} />
              </CardContent>
            </Card>
            {detail
              ? <RunnerDetailPanel detail={detail} busy={busy} onCancel={() => void cancel()} />
              : <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">选择一个 runner 查看详情。</CardContent></Card>}
          </div>
        </div>
      )}
    </>
  );
}
