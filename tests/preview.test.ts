import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageUrlOf } from "../server/images";
import { previewFile } from "../server/files";
import { MAX_IMAGE_BASE64_CHARS, MAX_IMAGE_THUMB_BASE64_CHARS } from "../shared/limits";
import type { Agent } from "../shared/contracts";
import type { PaseoApi } from "@getpaseo/client";
import type { ContextService } from "../server/service";
import { UiRoutes } from "../server/ui-routes";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("Retained image and current file previews", () => {
  test("accepts recorded image bytes and rejects oversized encoded images before transport", () => {
    expect(imageUrlOf("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(imageUrlOf({ source: { type: "base64", media_type: "image/png", data: "AAAA" } })).toBe("data:image/png;base64,AAAA");
    expect(imageUrlOf({ text: "not an image" })).toBeNull();
    const data = "A".repeat(MAX_IMAGE_BASE64_CHARS + 1);
    expect(() => imageUrlOf({ source: { type: "base64", media_type: "image/png", data } })).toThrow("20 MiB");
    expect(() => imageUrlOf(`data:image/png;base64,${data}`)).toThrow("20 MiB");
  });
  test("checks actual decoded size and propagates nested over-limit errors", () => {
    expect(imageUrlOf("data:image/png;base64,AAA=", 2)).toBe("data:image/png;base64,AAA=");
    expect(() => imageUrlOf("data:image/png;base64,AAAA", 2)).toThrow(/preview limit/);
    const encoded = "A".repeat(MAX_IMAGE_THUMB_BASE64_CHARS);
    const nested = JSON.stringify({ output: [{ source: { type: "base64", media_type: "image/jpeg", data: encoded } }] });
    expect(() => imageUrlOf(nested, 2 * 1024 * 1024)).toThrow("2 MiB");
    expect(imageUrlOf(nested)).toBe(`data:image/jpeg;base64,${encoded}`);
  });
  test("previews workspace text and denies unrelated files outside the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-context-preview-")); temporary.push(root);
    const cwd = join(root, "workspace"); await mkdir(cwd);
    await writeFile(join(cwd, "readme.md"), "# Demo\n");
    await writeFile(join(root, "unrelated.txt"), "private");
    const agent = { cwd } as Agent;
    expect(await previewFile(agent, [], "readme.md")).toMatchObject({ text: "# Demo\n", note: "Current file content." });
    await expect(previewFile(agent, [], "../unrelated.txt")).rejects.toThrow("captured paths");
  });

  test("applies variant defaults and clamped overrides through image and file preview RPCs", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-context-preview-")); temporary.push(root);
    const payload = Buffer.alloc(2 * 1024 * 1024 + 1);
    await writeFile(join(root, "large.png"), payload);
    await writeFile(join(root, "small.txt"), "text");
    const src = `data:image/png;base64,${payload.toString("base64")}`;
    const small = `data:image/png;base64,${Buffer.alloc(64 * 1024).toString("base64")}`;
    const overDesktopThumb = `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64")}`;
    const service = { pricing: { refresh: vi.fn(async () => {}) }, agent: async () => ({}),
      load: async () => ({ agent: { cwd: root }, fold: { files: [] } }),
      image: async (_id: string, node: number, _index: number, maxBytes: number) =>
        imageUrlOf(node === 0 ? src : node === 1 ? small : overDesktopThumb, maxBytes) } as unknown as ContextService;
    const routes = new UiRoutes(service), paseo = {} as PaseoApi;
    const image = (options: { variant?: string; maxBytes?: number } = {}, node = 0) =>
      routes.rpc("api/paseo-context/image", { agentId: "a", attachmentId: `paseo-context-image:${node}`, ...options }, paseo);
    const file = (path: string, maxBytes?: number) => routes.rpc("api/paseo-context/file.preview", { agentId: "a", path, maxBytes }, paseo);
    try {
      await expect(image()).resolves.toBe(src);
      await expect(image({ variant: "full" })).resolves.toBe(src);
      await expect(image({ variant: "thumb" })).rejects.toThrow("2 MiB");
      await expect(image({ variant: "thumb", maxBytes: 6 * 1024 * 1024 })).resolves.toBe(src);
      await expect(image({ variant: "thumb", maxBytes: 2 * 1024 * 1024 })).rejects.toThrow("2 MiB");
      await expect(image({ variant: "thumb", maxBytes: 20 * 1024 * 1024 }, 2)).rejects.toThrow("6 MiB");
      await expect(image({ variant: "full", maxBytes: 20 * 1024 * 1024 }, 2)).resolves.toBe(overDesktopThumb);
      await expect(image({ maxBytes: 1 }, 1)).resolves.toBe(small);
      await expect(image({ maxBytes: 1 })).rejects.toThrow("0.0625 MiB");
      await expect(file("large.png", 2 * 1024 * 1024)).rejects.toThrow("2 MiB");
      await expect(file("large.png", Infinity)).resolves.toMatchObject({ src });
      await expect(file("small.txt", 1)).resolves.toMatchObject({ text: "text" });
    } finally { routes.clear(); }
  });
});
