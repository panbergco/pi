import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveModelScope } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession reload re-resolves scoped models from settings", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-reload-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function writeEnabledModels(patterns: string[]) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: patterns }));
	}

	async function createSession(options: { fromSettings: boolean; extensionFactories?: ExtensionFactory[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options.extensionFactories ?? [],
		});
		await resourceLoader.reload();

		const scopedModels = await resolveModelScope(settingsManager.getEnabledModels() ?? [], modelRuntime);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			modelRuntime,
			resourceLoader,
			scopedModels,
			scopedModelsFromSettings: options.fromSettings,
		});
		return session;
	}

	const scopedIds = (session: Awaited<ReturnType<typeof createSession>>) =>
		session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);

	const extraProvider = {
		baseUrl: "http://localhost:8080",
		api: "anthropic-messages" as const,
		apiKey: "test-key",
		models: [
			{
				id: "extra-model",
				name: "Extra",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4_096,
			},
		],
	};

	async function waitFor(check: () => boolean) {
		for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	}

	it("picks up an edited enabledModels setting", async () => {
		writeEnabledModels(["anthropic/claude-sonnet-4-5"]);
		const session = await createSession({ fromSettings: true });
		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5"]);

		writeEnabledModels(["anthropic/claude-opus-4-5"]);
		await session.reload();

		expect(scopedIds(session)).toEqual(["anthropic/claude-opus-4-5"]);
		session.dispose();
	});

	it("leaves a scope that did not come from settings untouched", async () => {
		writeEnabledModels(["anthropic/claude-sonnet-4-5"]);
		const session = await createSession({ fromSettings: false });

		writeEnabledModels(["anthropic/claude-opus-4-5"]);
		await session.reload();

		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5"]);
		session.dispose();
	});

	it("includes models an extension registers during session_start", async () => {
		writeEnabledModels(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		const session = await createSession({
			fromSettings: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event) => {
						if (event.reason === "reload") pi.registerProvider("extra", extraProvider);
					});
				},
			],
		});
		// Resolved before any session_start: the extension model does not exist yet.
		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5"]);

		await session.bindExtensions({ onError: () => {} });
		await session.reload();

		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		session.dispose();
	});

	it("includes models an extension registers asynchronously after session_start", async () => {
		writeEnabledModels(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		const session = await createSession({
			fromSettings: true,
			extensionFactories: [
				(pi) => {
					// Not awaited by the handler: registration lands after reload() returns.
					pi.on("session_start", (event) => {
						if (event.reason === "reload") setTimeout(() => pi.registerProvider("extra", extraProvider), 20);
					});
				},
			],
		});

		await session.bindExtensions({ onError: () => {} });
		await session.reload();
		await waitFor(() => scopedIds(session).includes("extra/extra-model"));

		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		session.dispose();
	});

	it("keeps a session-only scope change until the next reload", async () => {
		writeEnabledModels(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		let register: (() => void) | undefined;
		const session = await createSession({
			fromSettings: true,
			extensionFactories: [
				(pi) => {
					register = () => pi.registerProvider("extra", extraProvider);
				},
			],
		});
		await session.bindExtensions({ onError: () => {} });
		const opus = getModel("anthropic", "claude-opus-4-5")!;
		session.setScopedModels([{ model: opus }]);

		register?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(scopedIds(session)).toEqual(["anthropic/claude-opus-4-5"]);

		await session.reload();
		expect(scopedIds(session)).toEqual(["anthropic/claude-sonnet-4-5", "extra/extra-model"]);
		session.dispose();
	});
});
