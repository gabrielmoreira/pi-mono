import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText } from "./harness.js";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function withUsage(message: AssistantMessage, totalTokens: number): AssistantMessage {
	return {
		...message,
		usage: createUsage(totalTokens),
	};
}

describe("tool output distill integration", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("injects distill parameters, distills a verbose tool result, and tracks distill usage", async () => {
		const describeFilesSchema = Type.Object({});
		const describeFilesTool: AgentTool<typeof describeFilesSchema> = {
			name: "describe_files",
			label: "Describe files",
			description: "Return a verbose listing of local files.",
			parameters: describeFilesSchema,
			async execute() {
				return {
					content: [
						{
							type: "text",
							text: [
								"README.md - Markdown documentation",
								"package.json - JSON package manifest",
								"src/main.ts - TypeScript entrypoint",
							].join("\n"),
						},
					],
					details: {},
				};
			},
		};

		const harness = await createHarness({
			settings: {
				distill: {
					enabled: true,
					model: "faux-1",
					minOutputChars: 10,
					display: "both",
					templates: ["describe_files: summarize file listings by extension"],
				},
			},
			tools: [describeFilesTool as unknown as AgentTool],
		});
		cleanups.push(harness.cleanup);

		const describeFiles = harness.session.agent.state.tools.find((tool) => tool.name === "describe_files");
		expect(describeFiles).toBeDefined();
		expect(
			(describeFiles?.parameters as { properties?: Record<string, unknown> }).properties?._distill,
		).toBeDefined();
		expect(
			(describeFiles?.parameters as { properties?: Record<string, unknown> }).properties?._distill_on_error,
		).toBeDefined();
		expect(harness.session.systemPrompt).toContain("## Tool Output Distillation");
		expect(harness.session.systemPrompt).toContain("describe_files: summarize file listings by extension");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("describe_files", {
					_distill: "Summarize the listed files by extension in one sentence.",
				}),
				{ stopReason: "toolUse" },
			),
			withUsage(fauxAssistantMessage("2 markdown/json files and 1 TypeScript file."), 17),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(
					getMessageText(toolResult).includes("TypeScript file")
						? "I saw the distilled summary."
						: "The raw listing leaked through.",
				);
			},
		]);

		await harness.session.prompt("List local files and use distill to summarize their nature.");

		const toolResultMessage = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResultMessage).toBeDefined();
		expect(getMessageText(toolResultMessage)).toBe("2 markdown/json files and 1 TypeScript file.");

		const toolEnd = harness.eventsOfType("tool_execution_end")[0];
		expect(toolEnd).toBeDefined();
		expect(toolEnd.result.distilled).toBe(true);
		expect(toolEnd.result.distillDisplay).toBe("both");
		expect(getMessageText({ content: toolEnd.result.rawContent })).toContain("README.md");
		expect(getMessageText({ content: toolEnd.result.rawContent })).toContain("package.json");
		expect(getMessageText({ content: toolEnd.result.rawContent })).toContain("src/main.ts");
		expect(toolEnd.result.distillUsage.totalTokens).toBeGreaterThan(0);

		const stats = harness.session.getSessionStats();
		expect(stats.distill.total).toBe(toolEnd.result.distillUsage.totalTokens);
		expect(stats.tokens.total).toBeGreaterThanOrEqual(stats.distill.total);
		expect(getAssistantTexts(harness)).toContain("I saw the distilled summary.");
	});

	it("skips distill for errors unless _distill_on_error is enabled", async () => {
		const harness = await createHarness({
			settings: {
				distill: {
					enabled: true,
					model: "faux-1",
					minOutputChars: 1,
				},
			},
		});
		cleanups.push(harness.cleanup);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("read", {
					path: "missing-file.txt",
					_distill: "Summarize the error in one sentence.",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(getMessageText(toolResult));
			},
		]);

		await harness.session.prompt("Try to read a missing file.");

		const toolEnd = harness.eventsOfType("tool_execution_end")[0];
		expect(toolEnd.result.distilled).toBeUndefined();
		expect(toolEnd.result.distillUsage).toBeUndefined();
		expect(getMessageText({ content: toolEnd.result.content })).toContain("missing-file.txt");

		const stats = harness.session.getSessionStats();
		expect(stats.distill.total).toBe(0);
		expect(getAssistantTexts(harness).some((text) => text.includes("missing-file.txt"))).toBe(true);
	});
});
