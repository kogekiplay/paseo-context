import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Agent, FileActivity } from "../shared/contracts";
import { imageByteLimit, imageSizeError } from "./images";

export async function previewFile(agent: Agent, files: FileActivity[], path: string, maxBytes?: number) {
  if (!path || path.includes("\0")) throw new Error("Invalid file path");
  const requested = resolve(agent.cwd, path), root = await realpath(agent.cwd);
  const target = await realpath(requested), rel = relative(root, target);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside && !files.some((file) => resolve(agent.cwd, file.path) === requested)) throw new Error("File is outside this session's captured paths");
  if (!(await stat(target)).isFile()) throw new Error("This item is not a file");
  const imageType = /\.(png|jpe?g|webp|gif|avif|bmp)$/i.exec(target)?.[1]?.toLowerCase();
  const max = imageType ? imageByteLimit(maxBytes) : 2 * 1024 * 1024;
  const file = await open(target, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("This item is not a file");
    if (imageType && info.size > max) throw imageSizeError(max);
    const bytes = Buffer.alloc(Math.min(info.size, max));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const content = bytes.subarray(0, offset);
    if (imageType) {
      const current = await file.stat();
      if (current.size > max) throw imageSizeError(max);
      if (current.size !== offset) throw new Error("File changed while reading its image preview");
      return { src: `data:image/${imageType === "jpg" ? "jpeg" : imageType};base64,${content.toString("base64")}`, name: path };
    }
    if (content.subarray(0, 8192).includes(0)) throw new Error("Binary file preview is unavailable");
    return { src: "", text: content.toString("utf8"), name: path,
      note: info.size > max ? "Current file content. Preview limited to the first 2 MiB." : "Current file content." };
  } finally { await file.close(); }
}
