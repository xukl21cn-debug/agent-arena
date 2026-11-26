import type { WorkTask } from '@arena/shared';

/** Persistence seam for the work domain. */
export interface WorkTaskStore {
  loadAll(): WorkTask[];
  save(task: WorkTask): void;
}
