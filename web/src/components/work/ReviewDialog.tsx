import { useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '../../api';
import { useWorkStore } from '../../store/work';

interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskTitle: string;
}

export function ReviewDialog({ open, onOpenChange, taskTitle }: ReviewDialogProps) {
  const review = useWorkStore((store) => store.review);
  const busy = useWorkStore((store) => store.busy);
  const [summary, setSummary] = useState('');
  const [findings, setFindings] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: 'approve' | 'rework') => {
    setError(null);
    if (!summary.trim()) {
      setError('请填写复审结论。');
      return;
    }
    if (decision === 'rework' && !findings.trim()) {
      setError('要求返工时请填写具体意见。');
      return;
    }
    try {
      await review(decision, summary.trim(), findings.trim() || undefined);
      setSummary('');
      setFindings('');
      onOpenChange(false);
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>复审任务</DialogTitle>
          <DialogDescription>{taskTitle}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="review-summary">复审结论</Label>
            <Textarea id="review-summary" value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} placeholder="说明核对结果和依据。" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="review-findings">返工意见（要求返工时必填）</Label>
            <Textarea id="review-findings" value={findings} onChange={(event) => setFindings(event.target.value)} rows={3} placeholder="具体指出要改什么。" />
          </div>
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="secondary" type="button" disabled={busy} onClick={() => void submit('rework')}><RotateCcw className="size-3.5" />要求返工</Button>
          <Button type="button" disabled={busy} onClick={() => void submit('approve')}><Check className="size-3.5" />复审通过</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
