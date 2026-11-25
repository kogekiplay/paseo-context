import { WorkflowItems, type EmitWorkflow } from "./workflow";

export type TaskStatus = "pending" | "in_progress" | "completed" | "canceled" | "failed";
interface PlanRow {
  id: string;
  group?: string;
  unkeyed?: boolean;
  subject?: string;
  status?: TaskStatus | "deleted";
}

function planIndex(rows: Iterable<PlanRow>, group: string) {
  const byId = new Map<string, PlanRow>(), bySubject = new Map<string, { total: number; active: number; completed: number }>();
  for (const row of rows) {
    if (row.group !== group || !row.subject?.trim() || !row.status || row.status === "deleted") continue;
    if (!row.unkeyed) {
      byId.set(row.id, row);
      continue;
    }
    const counts = bySubject.get(row.subject) ?? { total: 0, active: 0, completed: 0 };
    counts.total++;
    if (row.status === "pending" || row.status === "in_progress") counts.active++;
    if (row.status === "completed") counts.completed++;
    bySubject.set(row.subject, counts);
  }
  return { byId, bySubject };
}

export function notePlan(previous: Iterable<PlanRow>, current: readonly PlanRow[], group: string, emit: EmitWorkflow) {
  const before = planIndex(previous, group), after = planIndex(current, group);
  const changes = new Map<string, { added: number; done: number }>();
  for (const [subject, next] of after.bySubject) {
    const old = before.bySubject.get(subject);
    const added = Math.max(0, next.total - (old?.total ?? 0));
    // New items may already be completed. Count only transitions forced by
    // the snapshots when matching as many same-title items as possible.
    const freedActive = Math.max(0, (old?.active ?? 0) - next.active);
    const done = Math.min(freedActive, Math.max(0, next.completed - (old?.completed ?? 0) - added));
    changes.set(subject, { added, done });
  }
  const added = new WorkflowItems(), done = new WorkflowItems();
  for (const row of current) {
    const { subject, status } = row;
    if (!subject || !status || status === "deleted") continue;
    if (row.unkeyed) {
      const change = changes.get(subject);
      if (!change) continue;
      if (change.added > 0) { added.add(subject); change.added--; }
      if (change.done > 0 && status === "completed") { done.add(subject); change.done--; }
    } else if (after.byId.get(row.id) === row) {
      const old = before.byId.get(row.id);
      if (!old) added.add(subject);
      else if (old.status !== "completed" && status === "completed") done.add(subject);
    }
  }
  const addEvent = added.event("todo-add"), doneEvent = done.event("todo-done");
  if (addEvent) emit(addEvent);
  if (doneEvent) emit(doneEvent);
}
