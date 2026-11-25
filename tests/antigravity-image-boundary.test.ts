import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { antigravityImage } from "../server/images";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");
const ID = "247c9c90-1492-43b9-86ba-b49825487f4e";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

test.each(["open", "read"] as const)("denies an intermediate directory replacement during %s with the same image inode", async (stage) => {
  const root = await actual.mkdtemp(join(await actual.realpath(tmpdir()), "paseo-agy-directory-"));
  roots.push(root);
  const parent = join(root, "brain", ID, "media"), moved = `${parent}-old`, alternate = `${parent}-new`;
  const target = join(parent, "image.png");
  await actual.mkdir(parent, { recursive: true });
  await actual.writeFile(target, PNG);
  await actual.mkdir(alternate);
  await actual.link(target, join(alternate, "image.png"));
  const before = await actual.lstat(target, { bigint: true });
  let replaced = false;
  const replace = async () => {
    await actual.rename(parent, moved);
    await actual.rename(alternate, parent);
    replaced = true;
  };
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (args[0] === target) {
      if (stage === "open") await replace();
      else {
        const read = file.read.bind(file);
        Object.assign(file, { read: async (bytes: Buffer, offset: number, length: number, position: number) => {
          const result = await read(bytes, offset, length, position);
          await replace();
          return result;
        } });
      }
    }
    return file;
  });
  await expect(antigravityImage(root, ID, { uri: target, mime_type: "image/png" }, 1024)).resolves.toBeNull();
  const after = await actual.lstat(target, { bigint: true });
  expect(replaced).toBe(true);
  expect([after.dev, after.ino, after.ctimeNs]).toEqual([before.dev, before.ino, before.ctimeNs]);
  expect(await actual.realpath(target)).toBe(target);
});
