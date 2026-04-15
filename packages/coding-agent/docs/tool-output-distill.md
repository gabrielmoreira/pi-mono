# Tool Output Distillation

Tool calls often produce large outputs — file reads, bash command results, grep matches, compiler errors — most of which the agent doesn't need in full. Feeding raw output back into the main session context wastes tokens on every turn, accelerates context exhaustion, and increases compaction frequency.

Tool output distillation lets the LLM attach a compression prompt to any tool call. Instead of the raw output entering the main session context, a lightweight model processes it and returns only what the LLM asked for. The main session never sees the raw output.

This feature is inspired by [distill](https://github.com/samuelfaj/distill) by [@samuelfaj](https://github.com/samuelfaj).

**Source files** ([pi-mono](https://github.com/badlogic/pi-mono)):
- [`packages/agent/src/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/types.ts) — `DistillConfig`, `AgentLoopConfig.distill`, extended `tool_execution_end` event
- [`packages/agent/src/agent-loop.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts) — schema injection, distill execution, event emission
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/settings-manager.ts) — `DistillSettings`
- [`packages/coding-agent/src/core/agent-session-runtime.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts) — wires settings to `AgentLoopConfig.distill`
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) — accumulates distill token usage
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts) — injects distill section into system prompt when enabled
- [`packages/coding-agent/src/modes/interactive/components/tool-execution.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) — display logic for raw/distilled/both

## Overview

When distillation is enabled, two optional fields become available on every tool call schema:

| Field | Type | Default | Description |
|---|---|---|---|
| `_distill` | `string` | absent | Compression prompt for the distill model |
| `_distill_on_error` | `false \| true \| string` | `false` | Controls distill behavior when the tool returns an error |

The LLM includes these fields alongside normal tool arguments when it decides distillation is worthwhile. The agent loop intercepts the result after execution, runs the distill call, and replaces the content going into the main session context with the distilled version.

```
Tool call with _distill
  → tool.execute()              raw output
  → distill model call          raw output + _distill prompt
  → distilled output            replaces content in ToolResultMessage
  → main session context        sees only distilled output
```

## How the Agent Loop Uses It

The distill fields are injected into every tool's JSON schema by the agent loop before sending tools to the LLM. This includes built-in tools, extension-defined tools, and MCP tools — no individual tool requires modification.

After `tool.execute()` returns:

1. If `_distill` is absent → no distill call, normal flow.
2. If `_distill` is present and `isError = false` → call distill model with `_distill` as prompt.
3. If `_distill` is present and `isError = true`:
   - `_distill_on_error = false` (default) → skip distill, pass raw error to main session.
   - `_distill_on_error = true` → distill using `_distill` as prompt.
   - `_distill_on_error = "string"` → distill using that string as prompt instead of `_distill`.
4. If output size is below `distill.minOutputChars` threshold → skip distill (output is already small enough).
5. Distilled content replaces `ToolResultMessage.content`. Raw content is preserved in the `tool_execution_end` event for UI rendering.
6. `tool_execution_end` carries `rawResult` and `distillUsage` for consumers that need them.

The `ToolResultMessage` type is not modified. The LLM context stays clean.

## What the LLM Sees

The `tool_execution_end` event and the `ToolResultMessage` diverge intentionally:

| Layer | Content |
|---|---|
| LLM context (`ToolResultMessage.content`) | Distilled output (or raw if no distill) |
| UI / monitoring (`tool_execution_end.rawResult`) | Original raw output |
| Cost accounting (`tool_execution_end.distillUsage`) | Tokens used by distill call |

The LLM never sees `rawResult`. `rawResult` is only available to the UI layer.

## Configuration

Distillation is disabled by default. Enable it in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "distill": {
    "enabled": true,
    "model": "gemini-2.0-flash",
    "maxTokens": 2048,
    "minOutputChars": 500,
    "display": "distilled",
    "errorPrompt": "Summarize this error in 2 sentences: what failed and why.",
    "templates": [
      "bash: Extract exit code, errors, and relevant file/line references only.",
      "grep/find: List matching paths and one-line context per match.",
      "file read: Extract only the sections relevant to the current task.",
      "compiler output: List each unique error with file, line, and message. Omit warnings."
    ]
  }
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch. When false, zero overhead — no schema injection, no distill calls. |
| `model` | `string` | session active model | Model ID for distill calls. Use a fast, cheap model (e.g., flash-tier). Falls back to the session's active model if unset. |
| `maxTokens` | `number` | `2048` | Token cap for the distill model response. Prevents a distill call from costing more than the raw output would have. |
| `minOutputChars` | `number` | `500` | Minimum raw output character count before distillation runs. Outputs smaller than this threshold are passed through unchanged even if `_distill` is present. |
| `display` | `"raw" \| "distilled" \| "both"` | `"distilled"` | What the TUI renders. Does not affect what the LLM sees — the LLM always sees the distilled version. |
| `errorPrompt` | `string` | (see below) | Fallback distill prompt used when `_distill_on_error: true` but no `_distill` field was sent. Default: `"Summarize this error in 2 sentences: what failed and why."` |
| `templates` | `string[]` | `[]` | Distill prompt examples shown in the system prompt. Teaches the LLM when and how to use `_distill`. |

### Display Modes

| Mode | TUI renders | LLM sees |
|---|---|---|
| `"distilled"` (default) | Distilled output with `[distilled]` badge | Distilled |
| `"raw"` | Raw output (distill still ran for the LLM) | Distilled |
| `"both"` | Distilled output + collapsible raw section | Distilled |

`"raw"` is useful for debugging distill prompts — you see what the LLM did not.

## System Prompt Integration

When `distill.enabled = true`, a section is appended to the system prompt explaining the capability and showing the configured templates:

```
## Tool Output Distillation

You can reduce context usage by attaching a `_distill` field to any tool call.
The tool executes normally, but instead of the raw output entering this context,
a separate model compresses it using your prompt. You receive only the distilled result.

Use `_distill` when the tool output will be large and only a fraction is needed downstream.
Do not use it when the full output is required (e.g., applying a patch, validating a schema).

`_distill_on_error` controls behavior when the tool returns an error:
- `false` (default): pass raw error unchanged — errors are usually short and need full context.
- `true`: distill the error using the same `_distill` prompt.
- `"<prompt>"`: distill the error with this specific prompt instead.

Examples:
- bash: Extract exit code, errors, and relevant file/line references only.
- grep/find: List matching paths and one-line context per match.
- file read: Extract only the sections relevant to the current task.
- compiler output: List each unique error with file, line, and message. Omit warnings.
```

The examples section is populated from `distill.templates`. If `templates` is empty, no examples section is included.

When `distill.enabled = false`, this section is absent and `_distill` fields are not injected into tool schemas. The LLM has no knowledge of the capability.

## Token Usage Accounting

Distill calls are made by a secondary model outside the main session stream. Their token usage does not appear in `AssistantMessage.usage`. To prevent cost accounting from silently missing distill spend:

- Each `tool_execution_end` event carries `distillUsage?: Usage` when a distill call was made.
- `agent-session.ts` accumulates distill usage from these events into a dedicated `distillUsage` counter alongside the main session cost.
- The footer and stats panel show distill cost separately (e.g., `distill: $0.003`) so users can evaluate whether distillation is saving money overall.

## Type Changes

### `packages/agent/src/types.ts`

```typescript
/** Configuration for the distill model used to compress tool outputs. */
export interface DistillConfig {
    /** Execute a distill call. Returns the compressed content and token usage. */
    execute: (
        rawContent: (TextContent | ImageContent)[],
        prompt: string,
        signal?: AbortSignal,
    ) => Promise<{ content: (TextContent | ImageContent)[]; usage: Usage }>;
    /** Minimum raw output character count before distillation runs. */
    minOutputChars?: number;
    /** Field name to look for in tool arguments. Default: "_distill". */
    fieldName?: string;
    /** Fallback error distill prompt when _distill_on_error=true but _distill is absent. */
    errorPrompt?: string;
}

// AgentLoopConfig gains:
export interface AgentLoopConfig extends SimpleStreamOptions {
    // ... existing fields
    distill?: DistillConfig;
}

// tool_execution_end event gains two optional fields:
export type AgentEvent =
    // ... existing events
    | {
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: any;
        isError: boolean;
        rawResult?: any;         // present when distill was applied
        distillUsage?: Usage;    // token usage of the distill call
      };
```

`ToolResultMessage` is not modified. `rawContent` and `distillUsage` travel through the event bus, not through the LLM context message.

## What Does Not Change

- `ToolResultMessage` — no new fields
- `packages/ai/src/types.ts` — no changes
- Individual tool implementations — no changes
- MCP tools — no changes; schema injection happens at the agent-loop level
- `model-registry.ts` — no changes; distill model is resolved from a plain string ID

## Edge Cases

### Distill call fails
The distill model call can fail (rate limit, timeout, model error). On failure, the agent loop falls through to the raw content unchanged. The distill failure is logged but does not surface as a tool error to the main session — the tool call itself succeeded.

### `_distill_on_error = true` but `_distill` is absent
Use `distill.errorPrompt` as the prompt. If `errorPrompt` is also absent, use the hardcoded default: `"Summarize this error in 2 sentences: what failed and why."`. Never produce undefined behavior.

### Output below `minOutputChars`
Skip the distill call entirely. The `_distill` field is ignored. `rawResult` and `distillUsage` are absent from `tool_execution_end`. This prevents spending model tokens to compress outputs that are already compact.

### Parallel tool execution
The agent loop already supports parallel tool execution (`toolExecution: "parallel"`). Multiple distill calls run concurrently as part of each tool's finalization — this is correct and desirable. No special handling is needed.

### `maxTokens` cap too low
If `maxTokens` is set below what the distill model needs to produce a useful response, the output will be truncated at the token boundary. The result is still used as the distilled content. Users should set `maxTokens` high enough for their typical use case, or leave it at the default.

### LLM sends `_distill` on a non-verbose tool
The distill call runs regardless — there is no heuristic gating other than `minOutputChars`. If the output is already small and above `minOutputChars`, a distill call is made unnecessarily. The system prompt guidance discourages this, but cannot prevent it. The cost is bounded by `maxTokens`.

### Session export / history replay
`rawResult` lives only in the event stream and is not persisted to `ToolResultMessage`. Exported sessions and replayed history only have the distilled content. This is intentional: the distilled version is the ground truth for what the LLM saw.

## Test Strategy

### Unit tests (packages/agent)
- Schema injection: verify `_distill` and `_distill_on_error` appear in every tool's JSON schema when `DistillConfig` is set; verify they are absent when not set.
- Distill call routing: given a mock `DistillConfig.execute`, verify it is called with the correct prompt when `_distill` is present; not called when absent; not called when output is below `minOutputChars`.
- Error routing: verify the three `_distill_on_error` states produce the correct prompt or skip.
- Distill failure fallthrough: if `execute` throws, verify the raw content reaches `ToolResultMessage.content` unchanged.
- `tool_execution_end` event fields: verify `rawResult` and `distillUsage` are present after a successful distill and absent otherwise.
- Parallel execution: run two tool calls concurrently with distill, verify both distill calls complete and results are correct.

### Integration tests (packages/coding-agent)
- With `distill.enabled = false` (default): verify no schema injection occurs and no distill model calls are made.
- With `distill.enabled = true` and `model` set: verify distill model is resolved correctly; verify cost accounting accumulates `distillUsage` into the distill counter; verify the main session cost counter does not include distill spend.
- `minOutputChars` threshold: verify a small output passes through without distill; a large output triggers distill.
- System prompt: verify distill section appears when enabled; verify templates appear when configured; verify section is absent when disabled.
- Display modes: verify UI component shows correct content per `display` setting; verify raw content is available for `"both"` mode.

### What must not break
- All existing tool tests — tool implementations are not modified
- Compaction behavior — unrelated code path
- MCP tool registration and execution
- Sessions with `distill.enabled = false` (the default) must be byte-for-byte identical in behavior to sessions before this feature

## Build Plan

### Phase 1 — Core types (packages/agent)
Add `DistillConfig` to `packages/agent/src/types.ts`. Extend `tool_execution_end` AgentEvent with `rawResult?` and `distillUsage?`. Export `DistillConfig` from `packages/agent/src/index.ts`.

No behavior change in this phase — the new fields are optional and unused.

### Phase 2 — Agent loop integration (packages/agent)
Modify `packages/agent/src/agent-loop.ts`:
- Inject `_distill` and `_distill_on_error` optional fields into each tool's JSON schema when `AgentLoopConfig.distill` is set (in the function that builds tool definitions for the LLM).
- After `tool.execute()` returns, check for `_distill` in `toolCall.arguments`.
- Apply `minOutputChars` threshold check.
- Call `distill.execute()` with the appropriate prompt.
- On distill success: replace content in the result going to `ToolResultMessage`, populate `rawResult` and `distillUsage` on the `tool_execution_end` event.
- On distill failure: log, fall through to raw content, emit event without `rawResult`/`distillUsage`.

### Phase 3 — Settings (packages/coding-agent)
Add `DistillSettings` interface and `distill?` field to `Settings` in `packages/coding-agent/src/core/settings-manager.ts`.

### Phase 4 — Runtime wiring (packages/coding-agent)
In `packages/coding-agent/src/core/agent-session-runtime.ts`, read `distill.*` settings and construct `DistillConfig`, passing it to `AgentLoopConfig`. The `execute` function calls `completeSimple()` with the configured model, captures the response, and returns content + usage.

### Phase 5 — System prompt (packages/coding-agent)
In `packages/coding-agent/src/core/system-prompt.ts`, extend `BuildSystemPromptOptions` with `distillEnabled?: boolean` and `distillTemplates?: string[]`. Append the distill section to the system prompt when `distillEnabled = true`. Wire these from the session to the system prompt builder.

### Phase 6 — Cost tracking (packages/coding-agent)
In `packages/coding-agent/src/core/agent-session.ts`, subscribe to `tool_execution_end` events and accumulate `distillUsage` into a session-level counter. Expose the accumulated distill cost in session stats alongside the main session cost.

### Phase 7 — UI display (packages/coding-agent)
In `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`:
- Accept `rawResult` from `tool_execution_end`.
- Render according to `distill.display` setting.
- Show `[distilled]` badge when distill was applied.
- For `"both"` mode, render distilled content and a collapsible section with raw content.

### Phase 8 — Tests
Write unit and integration tests per the test strategy above. Run `npm run check` to verify no regressions.

## Future Work

- **Streaming distill**: run the distill call as a stream so the TUI can show progress on long distill calls instead of a blank pending state.
- **Per-tool distill defaults**: allow `distill.toolDefaults` to specify default `_distill` prompts for specific tools (e.g., always distill `bash` with a given prompt unless the LLM overrides it).
- **Distill quality feedback**: track cases where the LLM immediately re-fetches the same data after a distill, which may indicate a poor distill prompt; surface this in session stats.
