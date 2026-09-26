import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { ExtensionFactory } from "../src/index.ts";

// The session record says which extension added each message, and which extensions' context
// handlers changed which messages of a request — so a rewritten prefix can be traced to its author.
describe("the session record names who added and who changed a message", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function host(factories: ExtensionFactory[]) {
		const tempDir = join(tmpdir(), `pi-who-changed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model,
			resourceLoaderOptions: {
				extensionFactories: factories,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});
		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		const entries = () =>
			readFileSync(runtimeHost.session.sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
		return { runtimeHost, entries };
	}

	it("a message an extension adds is recorded with that extension's path, and two extensions are told apart", async () => {
		const { runtimeHost, entries } = await host([
			(pi) => {
				pi.on("session_start", () => pi.sendMessage({ customType: "from-a", content: "a", display: false }));
			},
			(pi) => {
				pi.on("session_start", () => pi.sendMessage({ customType: "from-b", content: "b", display: false }));
			},
		]);
		await runtimeHost.session.prompt("hello");
		const custom = entries().filter((e) => e.type === "custom_message");
		const a = custom.find((e) => e.customType === "from-a");
		const b = custom.find((e) => e.customType === "from-b");
		expect(typeof a?.source).toBe("string");
		expect(typeof b?.source).toBe("string");
		expect(a.source).not.toBe(b.source);
	});

	const records = (entries: () => Array<Record<string, any>>) =>
		entries().filter((e) => e.type === "custom" && e.customType === "context_changes");
	type Change = { extension: string; removed: string[]; added: string[]; changed: string[] };

	it("a handler that filters one message out is recorded as that one removal, never as every later message changed", async () => {
		const { runtimeHost, entries } = await host([
			(pi) => {
				pi.on("context", (event) => ({
					messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === "hidden")),
				}));
			},
			(pi) => {
				pi.on("session_start", () => pi.sendMessage({ customType: "hidden", content: "drop me", display: false }));
			},
		]);
		await runtimeHost.session.prompt("hello");
		await runtimeHost.session.prompt("again");
		const got = records(entries);
		expect(got.length).toBe(2);
		const first = got[0]!.data.changes as Change[];
		const second = got[1]!.data.changes as Change[];
		expect(first.length).toBe(1);
		expect(first[0]!.removed.length).toBe(1);
		expect(first[0]!.added).toEqual([]);
		expect(first[0]!.changed).toEqual([]);
		expect(second[0]!.removed).toEqual(first[0]!.removed);
	});

	it("a handler that rewrites a message is recorded as its old content removed and its new content added; an in-place edit as changed", async () => {
		const { runtimeHost, entries } = await host([
			(pi) => {
				pi.on("context", (event) => {
					const first = event.messages[0];
					if (first && first.role === "user")
						return { messages: [{ ...first, content: "rewritten" }, ...event.messages.slice(1)] };
					return undefined;
				});
			},
			(pi) => {
				pi.on("context", (event) => {
					const first = event.messages[0];
					if (first && first.role === "user") (first as { content: unknown }).content = "edited in place";
					return undefined;
				});
			},
		]);
		await runtimeHost.session.prompt("hello");
		const got = records(entries);
		expect(got.length).toBe(1);
		const [rewrite, edit] = got[0]!.data.changes as Change[];
		expect(rewrite!.removed.length).toBe(1);
		expect(rewrite!.added.length).toBe(1);
		expect(rewrite!.changed).toEqual([]);
		expect(edit!.changed.length).toBe(1);
		expect(edit!.removed).toEqual([]);
		expect(edit!.added).toEqual([]);
	});

	it("a request no context handler changed adds no record", async () => {
		const { runtimeHost, entries } = await host([
			(pi) => {
				pi.on("context", () => undefined);
			},
		]);
		await runtimeHost.session.prompt("hello");
		expect(records(entries).length).toBe(0);
	});
});
