import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '../../api';
import { useWorkStore } from '../../store/work';

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewTaskDialog({ open, onOpenChange }: NewTaskDialogProps) {
  const createTask = useWorkStore((store) => store.create);
  const busy = useWorkStore((store) => store.busy);
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [briefPath, setBriefPath] = useState('');
  const [briefSummary, setBriefSummary] = useState('已确认的任务说明');
  const [commitToBranch, setCommitToBranch] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.workContext().then((context) => {
      if (cancelled) return;
      if (context.branch) setBranch(context.branch);
      if (context.base) setBase(context.base);
    }).catch(() => {
      // Branch/base are optional prefills; the user can still type them.
    });
    return () => { cancelled = true; };
  }, [open]);

  const reset = () => {
    setTitle('');
    setRequirement('');
    setAcceptance('');
    setBriefPath('');
    setBriefSummary('已确认的任务说明');
    setCommitToBranch(true);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    const lines = acceptance.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!title.trim() || !requirement.trim() || !branch.trim() || !base.trim() || !briefPath.trim() || lines.length === 0) {
      setError('标题、需求、分支、基线、验收标准和 brief 路径都需要填写。');
      return;
    }
    const requirementText = commitToBranch
      ? requirement.trim()
      : `${requirement.trim()}\n\n完成后不要创建任何 git 提交，不要切换分支；把改动保留在工作区，并在结果中说明未提交。`;
    try {
      await createTask({
        title: title.trim(),
        requirement: requirementText,
        branch: branch.trim(),
        base: base.trim(),
        acceptance: lines,
        docs: [{ kind: 'brief', path: briefPath.trim(), summary: briefSummary.trim() || briefPath.trim() }],
      });
      reset();
      onOpenChange(false);
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>以看板用户身份派单；runner 在线时会在下一轮轮询领取。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="work-title">标题</Label>
            <Input id="work-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：补齐 runner 页面空态" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="work-requirement">需求</Label>
            <Textarea id="work-requirement" value={requirement} onChange={(event) => setRequirement(event.target.value)} rows={4} placeholder="说清目标、边界和不要做什么。" />
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="work-branch">分支</Label>
              <Input id="work-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feat/xxx" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="work-base">基线提交</Label>
              <Input id="work-base" value={base} onChange={(event) => setBase(event.target.value)} placeholder="40/64 位提交哈希" className="font-mono text-xs" />
            </div>
          </div>
          <p className="-mt-2 text-[11px] text-muted-foreground">自动填入当前工作区 HEAD；可改成任务要求的基线。</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={commitToBranch}
              onChange={(event) => setCommitToBranch(event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--gold)]"
            />
            <span>
              完成后提交到当前分支
              <span className="mt-0.5 block text-xs text-muted-foreground">
                取消勾选时要求执行者只修改工作区、不创建 git 提交。
              </span>
            </span>
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="work-acceptance">验收标准（每行一条）</Label>
            <Textarea id="work-acceptance" value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} placeholder={'例如：\n文件存在且内容正确\n提交只包含目标文件'} />
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-1.5">
              <Label htmlFor="work-brief-path">Brief 路径</Label>
              <Input id="work-brief-path" value={briefPath} onChange={(event) => setBriefPath(event.target.value)} placeholder="docs/proposals/xxx.md" className="font-mono text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="work-brief-summary">Brief 摘要</Label>
              <Input id="work-brief-summary" value={briefSummary} onChange={(event) => setBriefSummary(event.target.value)} />
            </div>
          </div>
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}><Plus className="size-3.5" />派单</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
