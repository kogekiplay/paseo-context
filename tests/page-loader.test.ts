import { afterEach, describe, expect, test, vi } from "vitest";
import { PageLoader, type PageTarget } from "../web/page-loader";

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
};
describe("Active page loading", () => {
  test("coalesces initialization and polls only after the previous read completes", async () => {
    vi.useFakeTimers();
    const first = deferred(), read = vi.fn(() => first.promise), accept = vi.fn();
    const loader = new PageLoader({ read, accept, error: vi.fn() });
    loader.configure({ agentId: "a", mode: "context" });
    loader.configure({ agentId: "a", mode: "context" }); loader.refresh();
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve({ selected: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    loader.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  test("switches immediately and ignores an old response even when its transport finishes later", async () => {
    vi.useFakeTimers();
    const a = deferred(), b = deferred(), accept = vi.fn(), error = vi.fn();
    const read = vi.fn((target: PageTarget, _signal: AbortSignal) => target.agentId === "a" ? a.promise : b.promise);
    const loader = new PageLoader({ read, accept, error });
    loader.configure({ agentId: "a", mode: "context" });
    const signal = read.mock.calls[0][1] as AbortSignal;
    loader.configure({ agentId: "b", mode: "statistics" });
    expect(signal.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    b.resolve("B"); a.resolve("A");
    await vi.advanceTimersByTimeAsync(0);
    expect(accept.mock.calls).toEqual([[{ agentId: "b", mode: "statistics" }, "B"]]);
    expect(error).not.toHaveBeenCalled();
    loader.dispose();
  });
  test("pauses hidden pages, resumes immediately and leaves settings and insights to their own sources", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true), loader = new PageLoader({ read, accept: vi.fn(), error: vi.fn() });
    loader.configure({ agentId: "a", mode: "fleet" });
    await vi.advanceTimersByTimeAsync(0);
    loader.visibility(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(1);
    loader.visibility(true);
    expect(read).toHaveBeenCalledTimes(2);
    loader.configure({ agentId: "a", mode: "settings" });
    loader.configure({ agentId: "a", mode: "insights" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(2);
    loader.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  test("an initially hidden frame waits until it becomes visible", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => true), loader = new PageLoader({ read, accept: vi.fn(), error: vi.fn() });
    loader.visibility(false);
    loader.configure({ agentId: "a", mode: "context" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).not.toHaveBeenCalled();
    loader.visibility(true);
    expect(read).toHaveBeenCalledTimes(1);
    loader.dispose();
  });
  test("retries failed refreshes and stops all work on disposal", async () => {
    vi.useFakeTimers();
    const error = vi.fn(), read = vi.fn(async () => { throw new Error("offline"); });
    const loader = new PageLoader({ read, accept: vi.fn(), error });
    loader.configure({ agentId: "a", mode: "modal" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    loader.dispose();
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
