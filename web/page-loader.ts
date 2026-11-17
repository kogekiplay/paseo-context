export interface PageTarget { agentId: string; mode: string }
interface LoaderOptions {
  read(target: PageTarget, signal: AbortSignal): Promise<unknown>;
  accept(target: PageTarget, result: any): void;
  error(error: unknown): void;
  interval?: number;
}

/** One active read per document; selection changes supersede old responses. */
export class PageLoader {
  private target: PageTarget | null = null;
  private visible = true;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: AbortController | null = null;
  constructor(private options: LoaderOptions) {}
  configure(target: PageTarget) {
    if (this.target?.agentId === target.agentId && this.target.mode === target.mode) return;
    this.stopRead(); this.target = target;
    this.refresh();
  }
  visibility(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.stopRead();
    if (visible) this.refresh();
  }
  refresh() {
    if (!this.visible || !this.target || this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const target = this.target, generation = this.generation;
    if (target.mode === "settings" || target.mode === "insights") return;
    const controller = new AbortController();
    this.pending = controller;
    void this.options.read(target, controller.signal).then((result) => {
      if (!controller.signal.aborted && generation === this.generation) this.options.accept(target, result);
    }).catch((error) => {
      if (!controller.signal.aborted && generation === this.generation) this.options.error(error);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.pending = null;
      if (this.visible) this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, this.options.interval ?? 5000);
    });
  }
  private stopRead() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending?.abort(); this.pending = null;
  }
  dispose() { this.stopRead(); this.target = null; }
}
