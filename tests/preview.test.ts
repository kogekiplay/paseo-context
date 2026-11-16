import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageUrlOf } from "../server/images";
import { previewFile } from "../server/files";
import { MAX_IMAGE_BASE64_CHARS } from "../shared/limits";
import type { Agent } from "../shared/contracts";

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
  test("previews workspace text and denies unrelated files outside the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-context-preview-")); temporary.push(root);
    const cwd = join(root, "workspace"); await mkdir(cwd);
    await writeFile(join(cwd, "readme.md"), "# Demo\n");
    await writeFile(join(root, "unrelated.txt"), "private");
    const agent = { cwd } as Agent;
    expect(await previewFile(agent, [], "readme.md")).toMatchObject({ text: "# Demo\n", note: "Current file content." });
    await expect(previewFile(agent, [], "../unrelated.txt")).rejects.toThrow("captured paths");
  });
});
