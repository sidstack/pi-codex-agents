import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Definition = Parameters<ExtensionAPI["registerTool"]>[0];
type Schema = Definition["parameters"];
const string = (description: string, maxLength = 4000) => ({ type: "string", description, minLength: 1, maxLength });
const object = (properties: Record<string, unknown>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false }) as Schema;
export const AGENT_TOOLS = [
  { name: "pi_agent_spawn", operation: "spawn", description: "Start one fresh, named native Pi worker without taking over the terminal. Capacity is bounded; never retry a timed-out spawn blindly. Workers cannot spawn more workers.", inputSchema: object({
    name: string("Short task-specific session name", 100), cwd: string("Absolute existing worktree/directory", 4096), task: string("One scoped task, owned files and acceptance checks", 16000),
    role: { type: "string", enum: ["implement", "review", "test", "research"], default: "implement" },
    provider: string("Optional provider; paired with model", 100), model: string("Optional model ID; paired with provider", 200),
  }, ["name", "cwd", "task"]) },
  { name: "pi_agent_list", operation: "list", description: "Compact worker states, IDs, names, errors and mailbox identity; no transcripts.", inputSchema: object({}) },
  { name: "pi_agent_send", operation: "send", description: "Send a bounded message to a worker, sibling, or parent. Mailbox delivery is durable. wake=true steers a busy worker or starts a settled worker only when capacity permits; default false never starts a model request.", inputSchema: object({
    to: string("Recipient worker ID or parent", 150), text: string("Concise question, progress, result or instruction"),
    kind: { type: "string", enum: ["message", "question", "progress", "result"] }, wake: { type: "boolean", default: false },
  }, ["to", "text"]) },
  { name: "pi_agent_inbox", operation: "inbox", description: "Read up to 20 messages after a cursor without consuming them or opening session histories. Save nextCursor for the next read.", inputSchema: object({ after: { type: "integer", minimum: 0 } }) },
  { name: "pi_agent_wait", operation: "wait", description: "Wait up to 25 seconds for new inbox messages. Uses a cursor, returns compact messages, and never runs a model.", inputSchema: object({ after: { type: "integer", minimum: 0 }, timeoutMs: { type: "integer", minimum: 0, maximum: 25000 } }) },
  { name: "pi_agent_stop", operation: "stop", description: "Explicitly abort and stop an owned worker, keeping its native history. Does not stop the host or other sessions.", inputSchema: object({ sessionId: string("Owned worker ID", 150) }, ["sessionId"]) },
] as const;

export function agentToolDefinitions(request: (operation: string, input: Record<string, unknown>, ctx: Parameters<Definition["execute"]>[4]) => Promise<unknown>): Definition[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    execute: async (_id, params, _signal, _update, ctx) => {
      const result = await request(tool.operation, params as Record<string, unknown>, ctx);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  }));
}
