import { useEffect, useState, type FormEvent } from 'react';
import type { ArtifactRef, TestEvidence, WorkStatus, WorkTask } from '@arena/shared';
import { useWorkStore } from '../../store/work';

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

function TaskDetail({ task }: { task: WorkTask }) {
  const busy = useWorkStore((store) => store.busy);
  const approve = useWorkStore((store) => store.approve);
  const takeover = useWorkStore((store) => store.takeover);
  const [reason, setReason] = useState('');
  const handleTakeover = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim()) void takeover(reason.trim());
  };
  return (
    <section className="panel work-detail" aria-label="任务详情">
      <div className="work-title">
        <h2 className="panel-title">{task.title}</h2><span>{labels[task.status]}</span>
      </div>
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
    </section>
  );
}

export function WorkPage() {
  const { connect, tasks, select, selected, detail, loading, error } = useWorkStore();
  useEffect(() => connect(), [connect]);
  return (
    <div className="app">
      <header className="topbar">
        <h1 className="title">开发任务</h1>
        <a className="btn btn--ghost" href="/">返回大厅</a>
      </header>
      {error && <p className="error-bar" role="alert">{error}</p>}
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
        {detail && <TaskDetail key={detail.id} task={detail} />}
      </main>
    </div>
  );
}
