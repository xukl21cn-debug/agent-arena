import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { interruptedDuringWork, type ArtifactRef, type TestEvidence, type WorkStatus, type WorkTask } from '@arena/shared';
import { Button } from '@/components/ui/button';
import { api } from '../../api';
import { useWorkStore } from '../../store/work';
import { usePageTitle } from '../layout/PageTitle';
import { BackLink } from '../layout/BackLink';
import { NewTaskDialog } from './NewTaskDialog';
import { ReviewDialog } from './ReviewDialog';

const labels: Record<WorkStatus, string> = {
  queued: '待领取', working: '执行中', pending_review: '待复审', reviewing: '复审中',
  rework_requested: '待返工', pending_ack: '待收工确认', pending_merge_approval: '待合并确认',
  merge_approved: '已放行', done: '已完成', needs_attention: '待接管', cancelled: '已取消',
};

function Artifacts({ taskId, docs }: { taskId: string; docs: ArtifactRef[] }) {
  if (!docs.length) return null;
  return (
    <ul className="work-docs">
      {docs.map((doc, index) => {
        const query = new URLSearchParams({ path: doc.path, hash: doc.hash });
        return (
          <li key={`${doc.path}:${doc.hash}:${index}`}>
            <a href={`/api/work/tasks/${encodeURIComponent(taskId)}/artifact?${query}`}>{doc.path}</a>
            <span>{doc.summary}</span>
            <code title={doc.hash}>SHA-256 {doc.hash}</code>
          </li>
        );
      })}
    </ul>
  );
}

function Tests({ tests }: { tests: TestEvidence[] }) {
  if (!tests.length) return null;
  return <ul>{tests.map((test, index) => (
    <li key={`${test.command}:${index}`}>
      <code>{test.command}</code> · {test.outcome === 'passed' ? '通过' : '失败'} {test.note}
    </li>
  ))}</ul>;
}

function TaskDetail({ task, canReview }: { task: WorkTask; canReview: boolean }) {
  const busy = useWorkStore((store) => store.busy);
  const approve = useWorkStore((store) => store.approve);
  const takeover = useWorkStore((store) => store.takeover);
  const cancel = useWorkStore((store) => store.cancel);
  const resume = useWorkStore((store) => store.resume);
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const handleTakeover = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim()) void takeover(reason.trim());
  };
  const handleCancel = (event: FormEvent) => {
    event.preventDefault();
    if (cancelReason.trim()) void cancel(cancelReason.trim());
  };
  const open = task.status !== 'done' && task.status !== 'cancelled';
  return (
    <section className="panel work-detail" aria-label="任务详情">
      <div className="work-title">
        <h2 className="panel-title">{task.title}</h2><span>{labels[task.status]}</span>
      </div>
      {canReview && task.status === 'pending_review' && (
        <Button className="work-approve" type="button" onClick={() => setReviewOpen(true)}>
          复审任务
        </Button>
      )}
      {interruptedDuringWork(task) && (
        <Button className="work-approve" type="button" disabled={busy} onClick={() => void resume()}>
          继续本轮
        </Button>
      )}
      {task.status === 'pending_merge_approval' && (
        <button className="btn btn--primary work-approve" type="button" disabled={busy} onClick={() => void approve()}>
          确认合并
        </button>
      )}
      <dl className="work-fields">
        <dt>分支</dt><dd><code>{task.branch}</code></dd>
        <dt>基线</dt><dd><code>{task.base}</code></dd>
        <dt>当前轮次</dt><dd>{task.activeRound}</dd>
      </dl>
      <h3>验收标准</h3>
      <ul>{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <Artifacts taskId={task.id} docs={task.docs} />
      {task.rounds.map((round) => (
        <section key={round.round} className="work-round" aria-label={`第 ${round.round} 轮`}>
          <h3>第 {round.round} 轮</h3>
          <p>{round.work?.summary ?? '等待执行回报。'}</p>
          {round.work?.commits.length ? <p>提交 <code>{round.work.commits.join(' · ')}</code></p> : null}
          {round.work?.files.length ? <p>文件 {round.work.files.join('、')}</p> : null}
          {round.work?.unresolved ? <p>未解决 {round.work.unresolved}</p> : null}
          <Tests tests={round.work?.tests ?? []} />
          <Artifacts taskId={task.id} docs={round.work?.docs ?? []} />
          {round.review && <>
            <h4>{round.review.decision === 'approve' ? '复审通过' : '要求返工'}</h4>
            <p>{round.review.summary}</p>
            {round.review.findings && <p>{round.review.findings}</p>}
            <Artifacts taskId={task.id} docs={[round.review.doc]} />
          </>}
        </section>
      ))}
      {task.status === 'merge_approved' && <p>已放行，等待统筹合并。</p>}
      {task.issue && <p role="status">{task.issue}</p>}
      {(task.status === 'needs_attention' || task.status === 'pending_ack') && (
        <form className="work-takeover" onSubmit={handleTakeover}>
          <label>接管原因 <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} required /></label>
          <button className="btn btn--ghost" type="submit" disabled={busy || !reason.trim()}>接管任务</button>
        </form>
      )}
      {open && (
        <form className="work-takeover" aria-label="取消任务" onSubmit={handleCancel}>
          <label>取消原因 <input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={2000} required /></label>
          <button className="btn btn--ghost" type="submit" disabled={busy || !cancelReason.trim()}>取消任务</button>
        </form>
      )}
      {task.merge && (
        <section className="work-round" aria-label="合并证据">
          <h3>合并证据</h3>
          <p>{task.merge.outcome === 'success' ? '合并成功' : '合并流程异常'}</p>
          {task.merge.mergeCommit && <code>{task.merge.mergeCommit}</code>}
          <Tests tests={task.merge.postMergeTests ?? []} />
          {task.merge.note && <p>{task.merge.note}</p>}
          <p>{task.merge.pushed ? `已推送 ${task.merge.remote ?? ''}` : '尚未推送'}</p>
        </section>
      )}
      <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} taskTitle={task.title} />
    </section>
  );
}

export function WorkPage() {
  usePageTitle('开发任务');
  const { connect, tasks, select, selected, detail, loading, error } = useWorkStore();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [humanCoordinatorId, setHumanCoordinatorId] = useState<string | null>(null);
  const blockedByAttention = tasks.some((task) => task.status === 'needs_attention');
  useEffect(() => connect(), [connect]);
  useEffect(() => {
    void api.workContext().then((context) => setHumanCoordinatorId(context.humanCoordinatorId)).catch(() => undefined);
  }, []);
  return (
    <>
      <div className="page-head">
        <div>
          <BackLink to="/" label="返回大厅" />
          <h2 className="page-title">开发任务</h2>
          <p className="page-subtitle">本机看板：领取、复审、收工确认与放行合并。</p>
        </div>
        <div className="page-head-meta">
          <Button type="button" onClick={() => setNewTaskOpen(true)}>
            <Plus className="size-3.5" />新建任务
          </Button>
        </div>
      </div>
      {error && <p className="error-bar" role="alert">{error}</p>}
      {blockedByAttention && (
        <p className="error-bar" role="status">有任务待接管，runner 暂时不会领取新任务；请先在任务详情处理待接管记录。</p>
      )}
      <main className="work-board">
        <nav className="panel work-list" aria-label="任务列表">
          <h2 className="panel-title">任务列表</h2>
          {loading ? <p>正在连接…</p> : !tasks.length ? <p>暂无任务。</p> : tasks.map((task) => (
            <button className="btn btn--ghost" type="button" key={task.id} aria-pressed={selected === task.id}
              onClick={() => void select(task.id)}>
              <strong>{task.title}</strong>
              <span>{labels[task.status]} · 第 {task.activeRound} 轮 · {task.workerName}</span>
              <time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time>
            </button>
          ))}
        </nav>
        {detail && <TaskDetail key={detail.id} task={detail} canReview={detail.coordinator.id === humanCoordinatorId} />}
      </main>
      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
    </>
  );
}
