import { act, create } from "react-test-renderer";
import { createElement, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  balanceEntryOf,
  peekPlatformBalances,
  PLATFORM_BALANCES_STORAGE_KEY,
  platformBalanceOf,
  platformBalancesOf,
  resetPlatformBalances,
  setPlatformBalanceStorage,
  subscribePlatformBalances,
  type StorageFace,
} from "../src/client/balance";
import { amountOf } from "../src/shared/decode";
import { useAnchoredPanel, type PanelSpot } from "../src/client/components/anchoredPanel";
import { makeBalanceCapsule } from "../src/client/components/balanceCapsule";
import { riseKeyOf } from "../src/client/components/timelineModel";
import { DICTS } from "../src/client/i18n";
import {
  IconAgentPreset,
  IconCheck,
  IconChevronDown,
  IconCompareSplit,
  IconFlatList,
  IconSparkle,
  IconWorkspaceTree,
} from "../src/client/primitives";
import { createContextSettings, type SettingsScopeLike } from "../src/client/settings";
import type { ClientCtx } from "../src/client/services";
import type { ViewKit } from "../src/client/viewkit";

const bridgeCallMock = vi.hoisted(() => vi.fn());

vi.mock("../web/bridge", () => ({
  call: (...args: unknown[]) => bridgeCallMock(...args),
}));

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    createPortal: (node: ReactNode) => node,
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (event: any) => void;

class FakeNode {
  private readonly children = new Set<FakeNode>();
  constructor(
    private readonly rect: { left: number; right: number; top: number; bottom: number; width: number; height: number } = {
      left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0,
    },
    public offsetWidth = 0,
    public offsetHeight = 0,
  ) {}
  focus = vi.fn();
  append(child: FakeNode): void {
    this.children.add(child);
  }
  contains(target: unknown): boolean {
    if (target === this) return true;
    for (const child of this.children) {
      if (child.contains(target)) return true;
    }
    return false;
  }
  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeHTMLElement extends FakeNode {}
class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLTextAreaElement extends FakeHTMLElement {}

const savedGlobals = {
  window: (globalThis as any).window,
  document: (globalThis as any).document,
  Node: (globalThis as any).Node,
  HTMLElement: (globalThis as any).HTMLElement,
  HTMLInputElement: (globalThis as any).HTMLInputElement,
  HTMLTextAreaElement: (globalThis as any).HTMLTextAreaElement,
};

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let winListeners: Record<string, Listener[]> = {};
let renderer: ReturnType<typeof create> | null = null;

function emitWin(type: string, event: any) {
  for (const fn of [...(winListeners[type] ?? [])]) fn(event);
}

const ACCOUNT = {
  isAvailable: true,
  balances: [
    { currency: "CNY", total: 110, granted: 10, toppedUp: 100 },
    { currency: "USD", total: 12.5, granted: 2.5, toppedUp: 10 },
  ],
};

const API = {
  isAvailable: true,
  balances: [
    { currency: "CNY", total: 90, granted: 20, toppedUp: 70 },
    { currency: "USD", total: 20, granted: 5, toppedUp: 15 },
  ],
};

function makeKitFor(locale: "en" | "zh"): ViewKit {
  const dict = DICTS[locale] as Record<string, string>;
  const t = (key: string, params: Record<string, string | number> = {}) => {
    let value = dict[key] ?? (DICTS.en as Record<string, string>)[key] ?? key;
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  };
  return { t, fmt: String, catLabel: (c: string) => c } as unknown as ViewKit;
}

function makeCtxFor(locale: "en" | "zh"): ClientCtx {
  return {
    locale: { getLocale: () => ({ active: locale }) },
  } as unknown as ClientCtx;
}

function makeReadySettings(
  initialSource: "account" | "api" = "account",
  options: { writable?: boolean; rejectSet?: boolean } = {},
) {
  let value: Record<string, unknown> = { balanceSource: initialSource };
  const writable = options.writable ?? true;
  const listeners = new Set<() => void>();
  const setSpy = vi.fn(async (field: string, next: unknown) => {
    if (options.rejectSet) throw new Error("save rejected");
    value = { ...value, [field]: next };
    for (const fn of listeners) fn();
  });
  const scope: SettingsScopeLike = {
    getSnapshot: () => ({ status: "ready", value, writable }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: setSpy,
  };
  const settings = createContextSettings();
  const detach = settings.attach(scope);
  const pushHostSnapshot = (nextValue: Record<string, unknown>) => {
    value = nextValue;
    for (const fn of listeners) fn();
  };
  return { settings, setSpy, detach, pushHostSnapshot };
}

class MemoryStorage implements StorageFace {
  store = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.store.set(k, v);
  }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

beforeEach(() => {
  bridgeCallMock.mockReset();
  resetPlatformBalances();
  setPlatformBalanceStorage(null);
  winListeners = {};
  (globalThis as any).Node = FakeNode;
  (globalThis as any).HTMLElement = FakeHTMLElement;
  (globalThis as any).HTMLInputElement = FakeHTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = FakeHTMLTextAreaElement;
  (globalThis as any).window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: (type: string, fn: Listener) => { (winListeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => {
      winListeners[type] = (winListeners[type] ?? []).filter((entry) => entry !== fn);
    },
  };
  (globalThis as any).document = {
    body: {},
    activeElement: null,
    contains: () => false,
  };
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  resetPlatformBalances();
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = value;
  }
});

describe("v0.87.2 balance decoding, riseKeyOf, anchoredPanel, and BalanceCapsule", () => {
  test("platformBalancesOf parses dual-source and single-source payloads and rejects malformed shapes", () => {
    expect(platformBalanceOf(ACCOUNT)).toEqual(ACCOUNT);
    expect(platformBalancesOf({ account: ACCOUNT, api: API })).toEqual({ account: ACCOUNT, api: API });
    expect(platformBalancesOf({ account: null, api: API })).toEqual({ account: null, api: API });
    expect(platformBalancesOf({ account: null, api: null })).toEqual({ account: null, api: null });
    expect(platformBalancesOf({ account: ACCOUNT })).toBeNull();
    expect(platformBalancesOf({ api: API })).toBeNull();
    expect(platformBalancesOf(null)).toBeNull();

    expect(balanceEntryOf(ACCOUNT, "cny")?.currency).toBe("CNY");
    expect(balanceEntryOf(ACCOUNT, "usd")?.currency).toBe("USD");
    expect(balanceEntryOf({ isAvailable: true, balances: [{ currency: "EUR", total: 5, granted: 0, toppedUp: 5 }] }, "usd")?.currency).toBe("EUR");
  });

  test("riseKeyOf varies across granularity, mode, and focus", () => {
    expect(riseKeyOf("step", "total", null)).toBe("step:total:");
    expect(riseKeyOf("turn", "total", null)).toBe("turn:total:");
    expect(riseKeyOf("step", "delta", null)).toBe("step:delta:");
    expect(riseKeyOf("step", "total", "tool")).toBe("step:total:tool");
    expect(riseKeyOf("step", "total", "user")).not.toBe(riseKeyOf("step", "total", "tool"));
  });

  test("useAnchoredPanel clamps horizontally on narrow viewports, flips above near bottom, and dismisses cleanly", async () => {
    (globalThis as any).window.innerWidth = 320;
    (globalThis as any).window.innerHeight = 200;

    const anchorNode = new FakeHTMLElement({ left: 10, right: 120, top: 150, bottom: 176, width: 110, height: 26 }, 110, 26);
    const panelNode = new FakeHTMLElement({ left: 0, right: 240, top: 0, bottom: 120, width: 240, height: 120 }, 240, 120);
    const insideChild = new FakeNode();
    panelNode.append(insideChild);
    const outsideNode = new FakeNode();

    const onClose = vi.fn();
    let latestSpot: PanelSpot | null = null;

    function Probe({ open }: { open: boolean }) {
      const anchorRef = useRef<HTMLElement | null>(anchorNode as unknown as HTMLElement);
      const panelRef = useRef<HTMLElement | null>(panelNode as unknown as HTMLElement);
      latestSpot = useAnchoredPanel(open, anchorRef, panelRef, onClose);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe, { open: true }));
    });

    // anchorRight(120) - panelWidth(240) = -120 -> clamped to MARGIN(8)
    // below(176 + 6 = 182) + 120 > 192 -> flips above: max(8, 150 - 120 - 6) = 24
    expect(latestSpot).toEqual({ left: 8, top: 24 });

    // Inside click does not dismiss
    emitWin("mousedown", { target: insideChild });
    expect(onClose).not.toHaveBeenCalled();

    // Outside click, scroll, and resize dismiss
    emitWin("mousedown", { target: outsideNode });
    emitWin("scroll", {});
    emitWin("resize", {});
    expect(onClose).toHaveBeenCalledTimes(3);

    // Closing removes all listeners and resets spot to null
    await act(async () => {
      renderer!.update(createElement(Probe, { open: false }));
    });
    expect(latestSpot).toBeNull();
    expect(winListeners.mousedown ?? []).toHaveLength(0);
    expect(winListeners.scroll ?? []).toHaveLength(0);
    expect(winListeners.resize ?? []).toHaveLength(0);
  });

  test("BalanceCapsule auto-selects api when account is null and omits caret for single source", async () => {
    bridgeCallMock.mockResolvedValue({ ok: true, value: { account: null, api: API } });
    const { settings, detach } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), settings);

    await act(async () => {
      renderer = create(createElement(Capsule));
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = renderer!.root.findByProps({ className: "lc-ov-balance" });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek API balance");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-value" }).children.join("")).toBe("$20.00");
    expect(renderer!.root.findAll((n) => n.type === "svg" && typeof n.props?.className === "string" && n.props.className.includes("lc-ov-balance-caret"))).toHaveLength(0);

    // Open dropdown dialog to inspect single arm rows and usage link
    await act(async () => { trigger.props.onClick(); });
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-label"]).toBe("DeepSeek balance");
    const values = renderer!.root.findAllByProps({ className: "lc-bal-row-value" }).map((n) => n.children.join(""));
    expect(values).toEqual(["$20.00", "$15.00", "$5.00"]);
    const link = renderer!.root.findByProps({ className: "lc-bal-usage" });
    expect(link.props.href).toBe("https://platform.deepseek.com/usage");
    detach();
  });

  test("BalanceCapsule switches between account and api arms and persists balanceSource setting", async () => {
    bridgeCallMock.mockResolvedValue({ ok: true, value: { account: ACCOUNT, api: API } });
    const { settings, setSpy, detach } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("zh"), makeKitFor("zh"), settings);

    await act(async () => {
      renderer = create(createElement(Capsule));
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = renderer!.root.findByProps({ className: "lc-ov-balance" });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek账号余额");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-value" }).children.join("")).toBe("¥110.00");
    expect(renderer!.root.findAll((n) => n.type === "svg" && typeof n.props?.className === "string" && n.props.className.includes("lc-ov-balance-caret"))).toHaveLength(1);

    // Open popover
    await act(async () => { trigger.props.onClick(); });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance" }).props["aria-expanded"]).toBe(true);
    expect(renderer!.root.findAll((n) => n.type === "svg" && typeof n.props?.className === "string" && n.props.className.includes("lc-ov-balance-caret-open"))).toHaveLength(1);
    const options = renderer!.root.findAll((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("lc-bal-option"));
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.props["aria-pressed"])).toEqual([true, false]);

    // Click second option (API balance)
    await act(async () => {
      options[1].props.onClick();
      await Promise.resolve();
    });

    expect(setSpy).toHaveBeenCalledWith("balanceSource", "api");
    expect(settings.balanceSource()).toBe("api");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance" }).props["aria-expanded"]).toBe(false);
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek API余额");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-value" }).children.join("")).toBe("¥90.00");
    detach();
  });

  test("BalanceCapsule renders nothing when both arms are absent", async () => {
    bridgeCallMock.mockResolvedValue({ ok: true, value: { account: null, api: null } });
    const { settings, detach } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), settings);

    await act(async () => {
      renderer = create(createElement(Capsule));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer!.toJSON()).toBeNull();
    detach();
  });

  test("primitives resolve all newly imported v0.87.2 vendor icons to SVG elements", () => {
    for (const Icon of [IconFlatList, IconCompareSplit, IconAgentPreset, IconWorkspaceTree, IconSparkle, IconCheck, IconChevronDown]) {
      const rendered = Icon({ size: 14 });
      expect(rendered).not.toBeNull();
    }
  });

  test("amountOf rejects blank and whitespace-only strings while preserving valid numbers (Minor #5)", () => {
    expect(amountOf("")).toBeNull();
    expect(amountOf("   ")).toBeNull();
    expect(amountOf("\t\n")).toBeNull();
    expect(amountOf("0")).toBe(0);
    expect(amountOf(" 12.5 ")).toBe(12.5);
    expect(amountOf(-1)).toBeNull();
    expect(platformBalanceOf({
      isAvailable: true,
      balances: [{ currency: "USD", total: "   ", granted: "0", toppedUp: "0" }],
    })).toBeNull();
  });

  test("Major #1: writable capsule follows host preference changes & save rollback, and settings sync falls back to account when missing/invalid", async () => {
    bridgeCallMock.mockResolvedValue({ ok: true, value: { account: ACCOUNT, api: API } });
    const { settings, detach, pushHostSnapshot } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), settings);

    await act(async () => {
      renderer = create(createElement(Capsule));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Pick api from capsule
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    const options = renderer!.root.findAll((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("lc-bal-option"));
    await act(async () => {
      options[1].props.onClick();
      await Promise.resolve();
    });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek API balance");

    // Host switches preference back to account -> capsule must immediately follow host
    await act(async () => { pushHostSnapshot({ balanceSource: "account" }); });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek account balance");

    // Old host snapshot missing balanceSource (or invalid value) falls back to 'account'
    await act(async () => { pushHostSnapshot({ balanceSource: "api" }); });
    expect(settings.balanceSource()).toBe("api");
    await act(async () => { pushHostSnapshot({}); });
    expect(settings.balanceSource()).toBe("account");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek account balance");

    await act(async () => { pushHostSnapshot({ balanceSource: "api" }); });
    expect(settings.balanceSource()).toBe("api");
    await act(async () => { pushHostSnapshot({ balanceSource: "invalid-source" }); });
    expect(settings.balanceSource()).toBe("account");

    detach();
    await act(async () => renderer!.unmount());
    renderer = null;

    // Save rejection rollback -> capsule reverts to saved 'account'
    const rejecting = makeReadySettings("account", { rejectSet: true });
    const RejectCapsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), rejecting.settings);
    await act(async () => {
      renderer = create(createElement(RejectCapsule));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    const rejectOpts = renderer!.root.findAll((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("lc-bal-option"));
    await act(async () => {
      rejectOpts[1].props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rejecting.settings.balanceSource()).toBe("account");
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek account balance");
    rejecting.detach();
    await act(async () => renderer!.unmount());
    renderer = null;

    // Read-only mode allows local toggle without calling settings.set, and still follows later host change
    const readonly = makeReadySettings("account", { writable: false });
    const ReadOnlyCapsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), readonly.settings);
    await act(async () => {
      renderer = create(createElement(ReadOnlyCapsule));
      await drain();
    });
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    const roOpts = renderer!.root.findAll((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("lc-bal-option"));
    await act(async () => { roOpts[1].props.onClick(); });
    expect(readonly.setSpy).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ className: "lc-ov-balance-label" }).children.join("")).toBe("DeepSeek API balance");
    readonly.detach();
  });

  test("Major #2: useAnchoredPanel ignores scroll inside the panel itself and closes on external scroll", async () => {
    const anchorNode = new FakeHTMLElement({ left: 10, right: 120, top: 20, bottom: 46, width: 110, height: 26 }, 110, 26);
    const panelNode = new FakeHTMLElement({ left: 0, right: 240, top: 0, bottom: 120, width: 240, height: 120 }, 240, 120);
    const insideChild = new FakeNode();
    panelNode.append(insideChild);
    const outsideScroller = new FakeNode();
    const onClose = vi.fn();

    function Probe() {
      const anchorRef = useRef<HTMLElement | null>(anchorNode as unknown as HTMLElement);
      const panelRef = useRef<HTMLElement | null>(panelNode as unknown as HTMLElement);
      useAnchoredPanel(true, anchorRef, panelRef, onClose);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe));
    });

    // Scrolling the panel itself or a descendant inside the panel must NOT close it
    emitWin("scroll", { target: panelNode });
    emitWin("scroll", { target: insideChild });
    expect(onClose).not.toHaveBeenCalled();

    // Scrolling an external container or document DOES close it
    emitWin("scroll", { target: outsideScroller });
    expect(onClose).toHaveBeenCalledTimes(1);
    emitWin("scroll", { target: {} });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("Minor #1: refreshing to empty balances closes open popover and removes all window listeners", async () => {
    const storage = new MemoryStorage({
      [PLATFORM_BALANCES_STORAGE_KEY]: JSON.stringify({ at: Date.now(), balances: { account: ACCOUNT, api: API } }),
    });
    setPlatformBalanceStorage(storage);

    let resolveRoute!: (val: unknown) => void;
    bridgeCallMock.mockImplementationOnce(() => new Promise((r) => { resolveRoute = r; }));

    const { settings, detach } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), settings);

    await act(async () => {
      renderer = create(createElement(Capsule));
    });

    // Cached balance paints immediately; open popover so listeners attach
    await act(async () => {
      renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick();
    });
    expect(renderer!.root.findByProps({ role: "dialog" })).toBeTruthy();
    expect((winListeners.keydown ?? []).length).toBeGreaterThan(0);
    expect((winListeners.mousedown ?? []).length).toBeGreaterThan(0);
    expect((winListeners.scroll ?? []).length).toBeGreaterThan(0);
    expect((winListeners.resize ?? []).length).toBeGreaterThan(0);

    // In-flight refresh settles with both arms absent -> renders null and detaches ALL listeners
    await act(async () => {
      resolveRoute({ ok: true, value: { account: null, api: null } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer!.toJSON()).toBeNull();
    expect(winListeners.keydown ?? []).toHaveLength(0);
    expect(winListeners.mousedown ?? []).toHaveLength(0);
    expect(winListeners.scroll ?? []).toHaveLength(0);
    expect(winListeners.resize ?? []).toHaveLength(0);
    detach();
  });

  test("Minor #2: Escape and selection restore trigger focus, while outside click dismisses without stealing focus", async () => {
    bridgeCallMock.mockResolvedValue({ ok: true, value: { account: ACCOUNT, api: API } });
    const { settings, detach } = makeReadySettings("account");
    const Capsule = makeBalanceCapsule(makeCtxFor("en"), makeKitFor("en"), settings);

    const triggerEl = new FakeHTMLElement({ left: 100, right: 260, top: 20, bottom: 46, width: 160, height: 26 }, 160, 26);
    const panelEl = new FakeHTMLElement({ left: 0, right: 240, top: 0, bottom: 120, width: 240, height: 120 }, 240, 120);
    const outsideButton = new FakeHTMLElement();

    (globalThis as any).document = {
      body: {},
      activeElement: triggerEl,
      contains: (node: unknown) => node === triggerEl || node === panelEl || node === outsideButton,
    };

    await act(async () => {
      renderer = create(createElement(Capsule), {
        createNodeMock: (el: any) => {
          if (el.props?.className === "lc-ov-balance") return triggerEl;
          if (el.props?.id === "lc-bal-panel") return panelEl;
          return new FakeHTMLElement();
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // 1. Open and dismiss via outside click -> must NOT steal focus back to triggerEl
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    triggerEl.focus.mockClear();
    await act(async () => { emitWin("mousedown", { target: outsideButton }); });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance" }).props["aria-expanded"]).toBe(false);
    expect(triggerEl.focus).not.toHaveBeenCalled();

    // 2. Open and dismiss via Escape -> MUST restore focus to triggerEl
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    triggerEl.focus.mockClear();
    await act(async () => {
      emitWin("keydown", {
        key: "Escape",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        target: panelEl,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    expect(renderer!.root.findByProps({ className: "lc-ov-balance" }).props["aria-expanded"]).toBe(false);
    expect(triggerEl.focus).toHaveBeenCalledTimes(1);

    // 3. Open and select an arm -> MUST restore focus to triggerEl
    await act(async () => { renderer!.root.findByProps({ className: "lc-ov-balance" }).props.onClick(); });
    triggerEl.focus.mockClear();
    const options = renderer!.root.findAll((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("lc-bal-option"));
    await act(async () => {
      options[1].props.onClick();
      await Promise.resolve();
    });
    expect(triggerEl.focus).toHaveBeenCalledTimes(1);
    detach();
  });

  test("Minor #3: resetPlatformBalances ignores stale pre-reset responses and unsubscribe prevents post-unmount callbacks", async () => {
    let resolveStale!: (val: unknown) => void;
    let resolveFresh!: (val: unknown) => void;
    bridgeCallMock
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveFresh = r; }));

    const storage1 = new MemoryStorage();
    setPlatformBalanceStorage(storage1);

    const staleListener = vi.fn();
    const unsubStale = subscribePlatformBalances(staleListener);

    // Reset before first request lands
    resetPlatformBalances();
    const storage2 = new MemoryStorage();
    setPlatformBalanceStorage(storage2);

    const freshListener = vi.fn();
    const unsubFresh = subscribePlatformBalances(freshListener);

    // Stale response lands late -> must NOT update cache, storage2, or notify freshListener, nor clear fresh refresh
    resolveStale({ ok: true, value: { account: ACCOUNT, api: null } });
    await drain();
    expect(peekPlatformBalances()).toBeNull();
    expect(storage2.getItem(PLATFORM_BALANCES_STORAGE_KEY)).toBeNull();
    expect(staleListener).not.toHaveBeenCalled();
    expect(freshListener).not.toHaveBeenCalled();

    // Unsubscribe stale cleanup after reset is a safe no-op
    unsubStale();

    // Fresh response lands -> updates cache, storage2, and notifies freshListener
    resolveFresh({ ok: true, value: { account: null, api: API } });
    await drain();
    expect(peekPlatformBalances()).toEqual({ account: null, api: API });
    expect(freshListener).toHaveBeenCalledTimes(1);
    expect(freshListener).toHaveBeenCalledWith({ account: null, api: API });
    unsubFresh();

    // Unsubscribing before settlement skips callback completely
    resetPlatformBalances();
    setPlatformBalanceStorage(null);
    let resolveDropped!: (val: unknown) => void;
    bridgeCallMock.mockImplementationOnce(() => new Promise((r) => { resolveDropped = r; }));
    const unmountedCb = vi.fn();
    const unsub = subscribePlatformBalances(unmountedCb);
    unsub();
    resolveDropped({ ok: true, value: { account: ACCOUNT, api: API } });
    await drain();
    expect(unmountedCb).not.toHaveBeenCalled();
  });
});
