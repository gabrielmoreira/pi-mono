import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type TSchema, Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

export interface WrapToolDefinitionOptions {
	enableDistill?: boolean;
}

function augmentParametersWithDistill<TParameters extends TSchema>(
	parameters: TParameters,
	enableDistill: boolean,
	toolLabel: string,
): TParameters {
	if (!enableDistill) {
		return parameters;
	}

	const schema = parameters as TParameters & { type?: string; properties?: Record<string, unknown> };
	if (schema.type !== "object") {
		return parameters;
	}

	if (schema.properties?._distill || schema.properties?._distill_on_error) {
		return parameters;
	}

	const distillPrompt = Type.Optional(
		Type.String({
			description: `Optional prompt for distilling ${toolLabel} output before it is returned to the main session context.`,
		}),
	);
	const distillOnError = Type.Optional(
		Type.Union([Type.Literal(false), Type.Literal(true), Type.String()], {
			description:
				"Controls distillation when the tool returns an error: false skips distill, true reuses _distill, and a string uses a separate error prompt.",
		}),
	);

	return {
		...schema,
		properties: {
			...schema.properties,
			_distill: distillPrompt,
			_distill_on_error: distillOnError,
		},
	} as TParameters;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
	options: WrapToolDefinitionOptions = {},
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: augmentParametersWithDistill(definition.parameters, options.enableDistill === true, definition.label),
		prepareArguments: definition.prepareArguments,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
	options: WrapToolDefinitionOptions = {},
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory, options));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
