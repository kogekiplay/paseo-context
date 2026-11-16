export interface Context {
  get(name: string): any;
  inject(names: readonly string[], callback: (context: any) => unknown): unknown;
  effect(callback: () => unknown, label?: string): unknown;
  [key: string]: any;
}
