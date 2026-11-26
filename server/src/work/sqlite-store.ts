import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkTask } from '@arena/shared';
import { ArenaDatabase } from '../db/database.js';
import { taskSchema } from './model.js';
import type { WorkTaskStore } from './persistence.js';

interface PayloadRow {
  payload: string;
}

function parseTask(row: PayloadRow | undefined, label: string): WorkTask | null {
  if (row === undefined) return null;
  try {
    return taskSchema.parse(JSON.parse(row.payload));
  } catch (error) {
    console.error(`[work-store] skipping corrupt ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** SQLite-backed work tasks; the task JSON remains the domain payload. */
export class SqliteWorkTaskStore implements WorkTaskStore {
  constructor(
    private readonly database: ArenaDatabase,
    importFrom?: string,
  ) {
    if (importFrom !== undefined) this.importLegacy(importFrom);
  }

  loadAll(): WorkTask[] {
    const rows = this.database.db.prepare('SELECT payload FROM work_tasks').all() as unknown as PayloadRow[];
    const tasks: WorkTask[] = [];
    for (const row of rows) {
      const task = parseTask(row, 'work task');
      if (task) tasks.push(task);
    }
    return tasks;
  }

  save(task: WorkTask): void {
    this.database.db.prepare(`
      INSERT INTO work_tasks(id, status, updated_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
    `).run(task.id, task.status, task.updatedAt, JSON.stringify(task));
  }

  private importLegacy(dataDir: string): void {
    const count = Number((this.database.db.prepare('SELECT COUNT(*) AS count FROM work_tasks').get() as { count: number }).count);
    if (count > 0) return;
    const directory = path.join(dataDir, 'work');
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    let imported = 0;
    this.database.transaction(() => {
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue;
        try {
          const task = taskSchema.parse(JSON.parse(readFileSync(path.join(directory, entry), 'utf8')));
          this.save(task);
          imported += 1;
        } catch (error) {
          console.warn(`[work-store] skipping old or invalid task file ${entry}:`, error instanceof Error ? error.message : error);
        }
      }
    });
    if (imported > 0) console.log(`[work-store] imported ${imported} tasks from legacy JSON.`);
  }
}
