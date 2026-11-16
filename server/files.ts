import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Agent, FileActivity } from "../shared/contracts";
import { MAX_IMAGE_BYTES } from "../shared/limits";

export async function previewFile(agent: Agent, files: FileActivity[], path: string) {
  if (!path || path.includes("\0")) throw new Error("Invalid file path");
  const requested = resolve(agent.cwd, path), root = await realpath(agent.cwd);
  const target = await realpath(requested), rel = relative(root, target);
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside && !files.some((file) => resolve(agent.cwd, file.path) === requested)) throw new Error("File is outside this session's captured paths");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("This item is not a file");
  const imageType = /\.(png|jpe?g|webp|gif|avif|bmp)$/i.exec(target)?.[1]?.toLowerCase();
  const max = imageType ? MAX_IMAGE_BYTES : 2 * 1024 * 1024;
  if (imageType && info.size > max) throw new Error("Image exceeds the 20 MiB preview limit");
  const file = await open(target, "r");
  try {
    const bytes = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, bytesRead);
    if (imageType) return { src: `data:image/${imageType === "jpg" ? "jpeg" : imageType};base64,${content.toString("base64")}`, name: path };
    if (content.subarray(0, 8192).includes(0)) throw new Error("Binary file preview is unavailable");
    return { src: "", text: content.toString("utf8"), name: path,
      note: info.size > max ? "Current file content. Preview limited to the first 2 MiB." : "Current file content." };
  } finally { await file.close(); }
}
