import { call } from "./bridge";

/** JSON grammar data, never executable downloaded code. */
export async function loadGrammar(name: string) {
  return { default: await call("ui.grammar", { name }) };
}
