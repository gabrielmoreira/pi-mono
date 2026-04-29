import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../src/config.js";

describe("getAgentDir", () => {
	let previousAgentDir: string | undefined;
	let previousProfile: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousProfile = process.env.PI_PROFILE;
		delete process.env[ENV_AGENT_DIR];
		delete process.env.PI_PROFILE;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousProfile === undefined) {
			delete process.env.PI_PROFILE;
		} else {
			process.env.PI_PROFILE = previousProfile;
		}
	});

	test("uses PI_CODING_AGENT_DIR when set", () => {
		process.env[ENV_AGENT_DIR] = "/custom/agent/dir";
		expect(getAgentDir()).toBe("/custom/agent/dir");
	});

	test("derives path from PI_PROFILE when PI_CODING_AGENT_DIR is unset", () => {
		process.env.PI_PROFILE = "work";
		expect(getAgentDir()).toMatch(/\.pi[/\\]profiles[/\\]work[/\\]agent$/);
	});

	test("PI_CODING_AGENT_DIR takes precedence over PI_PROFILE", () => {
		process.env[ENV_AGENT_DIR] = "/explicit/dir";
		process.env.PI_PROFILE = "work";
		expect(getAgentDir()).toBe("/explicit/dir");
	});

	test("falls back to default ~/.pi/agent when neither is set", () => {
		expect(getAgentDir()).toMatch(/\.pi[/\\]agent$/);
	});

	test("expands tilde in PI_CODING_AGENT_DIR", () => {
		process.env[ENV_AGENT_DIR] = "~/custom-agent";
		expect(getAgentDir()).not.toContain("~");
		expect(getAgentDir()).toMatch(/custom-agent$/);
	});

	test("handles empty PI_PROFILE as falsy and falls back to default", () => {
		process.env.PI_PROFILE = "";
		expect(getAgentDir()).toMatch(/\.pi[/\\]agent$/);
	});
});
