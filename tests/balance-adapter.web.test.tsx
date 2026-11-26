import type { PaseoApi } from "@getpaseo/client";
import { afterEach, expect, test, vi } from "vitest";
import { Metadata } from "../server/metadata";
import { Pricing } from "../server/pricing";
import { ContextService } from "../server/service";
import { SettingsPreview } from "../server/settings-preview";
import { UiRoutes } from "../server/ui-routes";
import { BALANCE_ROUTE } from "../src/client/apiRoutes";
import { platformBalancesOf } from "../src/client/balance";

vi.mock("../web/bridge", () => ({ call: vi.fn() }));

const absent = { account: null, api: null };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("balance is empty without an API key and settings preview stays offline with a key", async () => {
  const metadata = new Metadata();
  const preview = new SettingsPreview();
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected balance request")));
  vi.stubGlobal("fetch", fetch);
  try {
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const balance = await metadata.balance();
    expect(balance).toEqual(absent);
    expect(platformBalancesOf(balance)).toEqual(absent);

    vi.stubEnv("DEEPSEEK_API_KEY", "preview-test-key");
    const result = await preview.handle(BALANCE_ROUTE, {});
    expect(result).toEqual({ ok: true, value: absent });
    expect(platformBalancesOf((result as { value: unknown }).value)).toEqual(absent);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    metadata.clear();
    preview.clear();
  }
});

test("the live balance route shares concurrent API reads and returns a value the DOM UI accepts unchanged", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", "balance-test-key");
  const fetch = vi.fn(async () => Response.json({
    is_available: true,
    balance_infos: [
      { currency: "USD", granted_balance: "1.25", topped_up_balance: "3.50" },
      { currency: "CNY", granted_balance: "0", topped_up_balance: "0" },
      { currency: "USD", granted_balance: null, topped_up_balance: "3.50" },
      { currency: "USD", granted_balance: "-1", topped_up_balance: "3.50" },
      { currency: "USD", granted_balance: " ", topped_up_balance: "5" },
    ],
  }));
  vi.stubGlobal("fetch", fetch);
  const pricing = new Pricing();
  vi.spyOn(pricing, "refresh").mockResolvedValue(undefined);
  const service = new ContextService(undefined, pricing);
  const routes = new UiRoutes(service);
  const read = () => routes.rpc(BALANCE_ROUTE, {}, {} as PaseoApi);
  try {
    const value = {
      account: null,
      api: { isAvailable: true, balances: [
        { currency: "USD", total: 4.75, granted: 1.25, toppedUp: 3.5 },
        { currency: "CNY", total: 0, granted: 0, toppedUp: 0 },
      ] },
    };
    const [result, concurrent] = await Promise.all([read(), read()]);
    expect(result).toEqual({ ok: true, value });
    expect(concurrent).toEqual(result);
    await expect(read()).resolves.toEqual(result);
    expect(platformBalancesOf((result as { value: unknown }).value)).toEqual(value);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.deepseek.com/user/balance", {
      headers: { Authorization: "Bearer balance-test-key" },
      signal: expect.any(AbortSignal),
    });
  } finally {
    routes.clear();
    service.clear();
  }
});

test.each([
  ["an HTTP error", () => Promise.resolve(new Response(null, { status: 401 }))],
  ["a network rejection", () => Promise.reject(new Error("Offline"))],
  ["an invalid payload", () => Promise.resolve(Response.json({ balance_infos: [{ currency: "USD" }] }))],
])("an API lookup with %s returns two empty sources", async (_reason, fetch) => {
  vi.stubEnv("DEEPSEEK_API_KEY", "balance-test-key");
  vi.stubGlobal("fetch", fetch);
  const metadata = new Metadata();
  try {
    const balance = await metadata.balance();
    expect(balance).toEqual(absent);
    expect(platformBalancesOf(balance)).toEqual(absent);
  } finally { metadata.clear(); }
});
