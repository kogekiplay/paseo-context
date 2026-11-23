import type { ContextEvent } from "../shared/contracts";
import { detachSlice, record, text, type RecordValue } from "./value";

export type WorkflowEvent = Pick<ContextEvent, "kind" | "title"> & Partial<Pick<ContextEvent, "count" | "items" | "agent">>;
export type EmitWorkflow = (event: WorkflowEvent) => void;

export const workflowLabel = (value: string) => detachSlice(value.trim(), 180);

export class WorkflowItems {
  private count = 0;
  private items: string[] = [];

  add(value: string) {
    this.count++;
    if (this.items.length < 8) this.items.push(workflowLabel(value));
  }

  event(kind: "ask" | "todo-add" | "todo-done"): WorkflowEvent | undefined {
    if (this.count === 0) return undefined;
    return { kind, title: this.items[0], count: this.count, items: this.items };
  }
}

export function askOf(args: RecordValue): WorkflowEvent | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : [args.question];
  const items = new WorkflowItems();
  for (const value of questions) {
    const question = text(record(value).question ?? value).trim();
    if (question) items.add(question);
  }
  return items.event("ask");
}

export function goalOf(operation: unknown, objective: unknown): WorkflowEvent | undefined {
  const title = workflowLabel(text(objective));
  if (!title || (operation !== "create" && operation !== "complete")) return undefined;
  return { kind: operation === "create" ? "goal-create" : "goal-complete", title, count: 1 };
}
