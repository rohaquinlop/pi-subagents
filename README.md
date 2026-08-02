# @rohaquinlop/pi-subagents

A [pi](https://github.com/earendil-works/pi) extension that registers three agent orchestration tools — `subagent`, `pipeline`, and `loop` — with three built-in agents:

## Installation

```bash
pi install @rohaquinlop/pi-subagents
```

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls | deepseek-v4-flash | Fast codebase recon |
| **researcher** | web_search, web_fetch | deepseek-v4-flash | Web research |
| **worker** | read, write, edit, safe_bash, web_search, web_fetch, subagent | deepseek-v4-flash | Code changes (can dispatch scout/researcher to protect its own context) |

`worker` is allowlisted to spawn only `scout` and `researcher` (via `subagent_agents` in its frontmatter), so the chain stops at depth 2 — a worker cannot recurse into another worker.

## Dependencies

`safe_bash` ships in this repo (`tools/safe-bash.ts`). `web_search` and `web_fetch` do not — `researcher` and `worker` depend on them. Grab those two extensions from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config) (`extensions/web-search/`, `extensions/web-fetch/`) and drop them into `~/.pi/agent/extensions/`. Without them the affected agents will launch with an empty tool allowlist and silently do nothing useful.

## Usage

### Subagent — Single Agent Dispatch

One tool call = one subagent:
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

To fan out, emit multiple `subagent` tool calls in the same assistant turn — pi runs them in parallel automatically. A per-process semaphore caps simultaneous subagents at `maxConcurrency` (default 4); calls past the cap wait their turn.

Each subagent runs as an isolated `pi` process with no inherited context — all context must be in the task description.

### Pipeline — Sequential Agent Chains

Chain 2–5 agents in sequence where each agent's output feeds as context into the next. Use `{previous}` in a step's task to inject the prior step's output.

```json
{ "tool": "pipeline", "args": { "steps": [
  { "agent": "scout", "task": "Find all auth-related code in src/" },
  { "agent": "worker", "task": "Based on these findings:\n{previous}\n\nImplement password reset flow." }
]}}
```

Each step runs a separate subagent process. The pipeline stops on the first error. Per-step and total usage (tokens, cost, duration) are shown in the TUI.

### Loop — Iterative Refinement

Run the same agent 2–5 times, passing all prior iteration outputs as context. Optionally use a `judge` agent to stop early when quality is sufficient.

**Basic (fixed iterations):**

```json
{ "tool": "loop", "args": {
  "agent": "worker",
  "task": "Write a comprehensive README for this project.",
  "max_iterations": 3
}}
```

**With judge for dynamic stopping:**

```json
{ "tool": "loop", "args": {
  "agent": "worker",
  "task": "Write a comprehensive README for this project.",
  "max_iterations": 5,
  "judge": {
    "agent": "reviewer",
    "criteria": "Is this README complete, well-structured, and ready for publication? Answer YES or NO."
  }
}}
```

The judge evaluates each iteration's output. When satisfied (YES), the loop stops early — no wasted iterations. Judge feedback is passed back to the runner agent for refinement.

## Config

Config is read from two locations, the second overriding the first:

1. `config.json` next to `index.ts` — inside `node_modules`, so it is usually
   gitignored and is **replaced whenever the package updates**. Fine for a
   throwaway local tweak.
2. `~/.pi/agent/pi-subagents.config.json` — survives updates and can be tracked
   alongside the rest of your pi config. Put anything you want to keep here.

```json
{ "maxConcurrency": 4 }
```

Merging is shallow: a key set in the user file replaces the package file's value
outright. A malformed file is skipped with a warning rather than silently
dropping your settings.

### Model tiers

Pinning a concrete model in every agent file couples the whole fleet to one
provider — switching means editing each file. Define tiers instead, in
`~/.pi/agent/pi-subagents.config.json` so they survive package updates:

```json
{
  "modelTiers": {
    "fast": "deepseek/deepseek-v4-flash",
    "deep": "deepseek/deepseek-v4-pro"
  }
}
```

Agent files then reference a tier by role, and one config edit repoints them all:

```yaml
model: $fast
```

A tier may point at another tier, or at `inherit`. Cycles are detected and
reported rather than followed. An undefined tier fails the dispatch with the
agent named — it never falls back to some default model.

## Output

Subagents return text only — there's no file handoff. If the parent needs artifacts, instruct the subagent to `write` them and return the path.

Large outputs (>`DEFAULT_MAX_BYTES`) are head-truncated before being returned to the parent.

## UI

Two levels, toggled with `ctrl+o`:

- **Collapsed (default):** the tool call shows one line — `subagent <agent> <60-char task preview>`. The result block shows the agent header (status, tool count, duration), the chronological tool log (one line per call, running calls marked with `▸`), the latest prose "thinking" line, and a usage line (tokens in/out, cache, cost, context-window gauge).
- **Expanded:** the call header streams the full task body live as the parent writes it (like `write`/`edit`). The result block additionally renders the subagent's full final output as markdown. Nested children (when a worker spawns scout/researcher) render inline, indented under the row that dispatched them, with their own per-row context gauge.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension). Include `subagent` here to let this agent spawn other agents.
- **model** (required) — provider-agnostic model identifier (e.g. `deepseek-v4-flash`). Pi resolves it from any registered provider that serves it. Two indirections avoid pinning a provider here: `inherit` uses whatever model the session is currently on (and follows `/model` switches), and `$name` looks up a tier from [`modelTiers`](#model-tiers). Nested subagents inherit the top-level session model via `PI_SUBAGENT_INHERIT_MODEL`.
- **thinking** (required) — reasoning level: `off`, `low`, `medium`, `high`. A file missing this is skipped during discovery, same as one missing `name`, `description`, `tools` or `model`.
- **subagent_agents** — if `subagent` is in `tools`, restrict which agents this one may spawn. Comma-separated list of agent names. Omit for no restriction. Enforced by passing `PI_SUBAGENT_ALLOWED` env to the child `pi` process — the child's subagents extension filters its registry before any tool description sees it, so the child LLM literally can't reference an agent outside the allowlist.

The markdown body becomes the agent's system prompt.

Agents can optionally declare a `connector` field in their frontmatter — a prompt template that wraps their output before it's passed as `{previous}` to the next agent in a pipeline:

```yaml
connector: "## Key findings from codebase exploration:\n\n{output}"
```

Connectors use single-line format with `\n` for line breaks. They can be overridden per-step via the optional `connector` field on pipeline steps.

### 2. Register agents via `globalThis.__pi_subagents`

Pi loads extensions via jiti, which creates separate module instances. Direct imports from the subagents extension will reference a different `agents` array than the one the `subagent` tool uses. Use the `globalThis` bridge instead:

```typescript
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  thinking: string;        // "off" | "low" | "medium" | "high"
  systemPrompt: string;
  filePath: string;
  subagentAgents?: string[]; // optional spawn-allowlist when `subagent` is in tools
}

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    const subagentAgents = frontmatter.subagent_agents
      ? frontmatter.subagent_agents.split(",").map(t => t.trim()).filter(Boolean)
      : undefined;
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
        thinking: frontmatter.thinking || "medium",
        systemPrompt: body,
        filePath,
        ...(subagentAgents ? { subagentAgents } : {}),
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_search: path.join(EXT_BASE, "web-search", "index.ts"),
  web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
  video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
  youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
  google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts`.

The `subagent` tool itself is listed in `CUSTOM_TOOL_EXTENSIONS` pointing back to this extension's own `index.ts` — that's how an agent like `worker` can recursively spawn other agents. Recursion is bounded only by each agent's `subagent_agents` allowlist (e.g. worker can spawn scout/researcher, neither of which declares the `subagent` tool, so the chain stops at depth 2).

### 4. Model-specific extensions (no manual mapping)

Extensions that apply to specific models (not tools) can declare `appliesToModels`
in their `package.json` and auto-load without any `CUSTOM_TOOL_EXTENSIONS` mapping:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "appliesToModels": ["deepseek-*"]
  }
}
```

When a subagent's configured model matches one of the patterns, the extension is
loaded via `--extension` in the child process. Glob patterns (`*` wildcard) match
the **model ID** (the portion after the last `/`, e.g. `deepseek-v4-flash` in
`nan/deepseek-v4-flash`). Plain strings without wildcards match the **provider
name** (the portion before the `/`, e.g. `nan` in `nan/deepseek-v4-flash`).
Matching is case-insensitive.

## Structure

```
@rohaquinlop/pi-subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
├── lib/               # Pure helper functions (agent discovery, frontmatter parsing,
│                      #   config loading, model tier resolution)
└── tools/             # Extensions loaded into subagent processes
    └── safe-bash.ts   # bash with dangerous command blocking
```

## Acknowledgements

The pipeline and loop tools are conceptually inspired by [RecursiveMAS](https://arxiv.org/abs/2604.25917) — a research framework for scaling agent collaboration through iterative refinement and system-level orchestration.
