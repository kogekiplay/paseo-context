import type { Agent } from "../shared/contracts";
import { antigravityConversationId } from "./antigravity-log";

export function fleetResolver(agents: readonly Agent[], supplied?: ReadonlyMap<string, string>) {
  const aliases = new Map(supplied), names = new Map<string, string | null>();
  for (const agent of agents) {
    aliases.set(agent.id, agent.id);
    if (agent.sessionId) {
      aliases.set(`${agent.provider}:${agent.sessionId}`, agent.id);
      aliases.set(`native:${agent.provider}:${agent.sessionId}`, agent.id);
    }
    names.set(agent.title, names.has(agent.title) ? null : agent.id);
  }
  return (value: string, provider: string, paseoAgent?: boolean): string => {
    if (paseoAgent === true) return aliases.get(value) ?? value;
    const agyId = provider === "antigravity" ? antigravityConversationId(value) : null;
    const id = agyId ?? value;
    const native = `native:${provider}:${id}`;
    if (paseoAgent === false) return agyId ? aliases.get(native) ?? native : names.get(value) ?? value;
    return aliases.get(value) ?? aliases.get(native) ?? aliases.get(`${provider}:${id}`) ?? names.get(value) ?? id;
  };
}
