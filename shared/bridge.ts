import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const bridgeRpc = defineRpc({
  name: "context.ui",
  input: z.object({ route: z.string().min(1).max(200), payload: z.unknown() }),
  output: z.unknown(),
});
