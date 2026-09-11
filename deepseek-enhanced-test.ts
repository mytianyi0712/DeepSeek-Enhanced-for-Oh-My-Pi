import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * DeepSeek Enhanced - Test Version with Native Edit.
 * 
 * 测试将 str_replace_editor 替换为原生 edit 工具是否会影响思维链质量。
 * 
 * Changes from original:
 * - Removed str_replace_editor custom tool registration
 * - Added native edit tool to CORE_TOOLS
 * - Updated system prompt to reference edit instead of str_replace_editor
 */

const EDIT = "edit";
const BASH = "bash";
const XD_READ = "read";
const XD_WRITE = "write";
const CORE_TOOLS = [BASH, EDIT] as const;
const XD_TRANSPORT_TOOLS = [XD_READ, XD_WRITE] as const;
const DIRECT_TOOL_NAMES = new Set<string>([...CORE_TOOLS, ...XD_TRANSPORT_TOOLS]);
const EXTENSION_NAME = "deepseek-enhanced-test";
const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";
const ALLOWED_CUSTOM_TYPES: Record<string, true> = { "skill-prompt": true };

type RecordValue = Record<string, unknown>;

type XdToolInfo = { name: string; summary: string };


type SessionState = {
	baseTools: string[];
	prepared: boolean;
	minimal: boolean;
	transport: boolean;
	xdTools: string[];
	xdCatalog: XdToolInfo[];
	xdDispatchIds: Set<string>;
};

function uniqueNames(names: readonly string[]): string[] {
	return [...new Set(names.filter(name => typeof name === "string" && name.length > 0))];
}

function recordValue(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function toolSummary(description: string | undefined): string {
	if (!description) return "";
	const lines = description.split("\n").map(line => line.trim());
	return lines.length > 0 ? lines[0] : "";
}

function formatXdCatalog(catalog: readonly XdToolInfo[]): string {
	return catalog.map(entry => `- ${entry.name}${entry.summary ? ` — ${entry.summary}` : ""}`).join("\n");
}


function isXdWriteInput(input: unknown): boolean {
	const record = recordValue(input);
	return !!record && typeof record.path === "string" && record.path.startsWith("xd://");
}

function modelKey(model: ExtensionContext["model"]): string {
	return typeof model === "string" ? model : model.id ?? "";
}

function isDeepSeek(model: ExtensionContext["model"]): boolean {
	return modelKey(model).includes("deepseek");
}

function sessionId(ctx: ExtensionContext): string {
	return typeof ctx.session === "string"
		? ctx.session
		: ctx.session && typeof ctx.session === "object" && "id" in ctx.session && typeof ctx.session.id === "string"
			? ctx.session.id
			: "default";
}

function warn(pi: ExtensionAPI, message: string): void {
	try {
		pi.log({ level: "warn", message: `[${EXTENSION_NAME}] ${message}` });
	} catch {
		// Silent fallback
	}
}

function stripDateCwdText(content: string): { content: string; changed: boolean } {
	const cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
	return { content: cleaned, changed: cleaned !== content };
}

function stripDateCwdReminder(content: unknown): { content: unknown; changed: boolean } {
	if (typeof content === "string") return stripDateCwdText(content);
	if (!Array.isArray(content)) return { content, changed: false };
	let changed = false;
	const result = content.map(block => {
		if (recordValue(block)?.type !== "text" || typeof block.text !== "string") return block;
		const stripped = stripDateCwdText(block.text);
		if (stripped.changed) changed = true;
		return { ...block, text: stripped.content };
	});
	return { content: result, changed };
}

function extractToolName(tool: unknown): string | undefined {
	const record = recordValue(tool);
	return record && typeof record.name === "string" ? record.name : undefined;
}

function stripEternalProviderPayload(payload: unknown, visibleNames: readonly string[]): unknown {
	const record = recordValue(payload);
	if (!record) return payload;
	const visible = new Set(visibleNames);
	const messages = Array.isArray(record.messages) ? record.messages : [];
	const tools = Array.isArray(record.tools) ? record.tools : [];
	const filtered = tools.filter(tool => {
		const name = extractToolName(tool);
		return name && visible.has(name);
	});
	const cleaned = messages.map(message => {
		const msg = recordValue(message);
		if (!msg || msg.role !== "user") return message;
		const stripped = stripDateCwdReminder(msg.content);
		return stripped.changed ? { ...msg, content: stripped.content } : message;
	});
	return {
		...record,
		tools: filtered,
		messages: cleaned,
	};
}

function filterEternalContext(messages: readonly unknown[]): unknown[] {
	return messages.filter(message => {
		const record = recordValue(message);
		if (!record || record.role !== "user") return true;
		const type = typeof record.type === "string" ? record.type : undefined;
		return !type || ALLOWED_CUSTOM_TYPES[type];
	});
}

function xdInstruction(state: SessionState): string {
	const transport = state.transport
		? [
				"OMP's native xd:// transport is enabled:",
				"- use read with path `xd://` to list mounted devices.",
				"- use read with path `xd://<tool>` to fetch one tool's docs and JSON schema.",
				"- use write with path `xd://<tool>` and content set to one JSON args object to execute the real tool.",
				state.xdTools.length > 0
					? `Registered high-order tools (access through xd:// when mounted):\n${formatXdCatalog(state.xdCatalog)}`
					: "No additional high-order tools are currently registered in this session.",
		]
		: ["The read/write xd:// transport is unavailable because this session did not grant both transport tools."];
	const direct = state.transport ? "bash, edit, read, and write" : "bash and edit";
	return [
		`This is Eternal Minimal: the only directly callable tools are ${direct}.`,
		"Do not call any other tool name directly, even if it appears familiar; use the xd:// transport for every non-core capability.",
		...transport,
		"",
		"For every high-order tool above, first read `xd://<tool>` to get its exact docs and JSON schema, then write `xd://<tool>` with one JSON args object to execute it.",
		"If the tool you need is not listed, run read with path `xd://` to discover the currently mounted devices.",
		"If you need user input or confirmation, use the ask tool through xd:// when it is mounted.",
		"Use bash and edit directly for shell and file work. OMP performs the real xd:// schema validation, approval, execution, and rendering.",
		"Example: read {\"path\": \"xd://ask\"} to fetch ask's schema, then write {\"path\": \"xd://ask\", \"content\": \"{\\\"questions\\\":[{\\\"id\\\":\\\"confirm\\\",\\\"question\\\":\\\"Proceed?\\\",\\\"options\\\":[{\\\"label\\\":\\\"Yes\\\"},{\\\"label\\\":\\\"No\\\"}]}]}\"} to execute it.",
	].join("\n");
}

export default function registerDeepSeekEnhanced(pi: ExtensionAPI): void {
	// Note: str_replace_editor registration removed - using native edit tool instead
	const states = new Map<string, SessionState>();
	let warnedMissingCore = false;
	let warnedTransport = false;

	function stateFor(ctx: ExtensionContext): SessionState {
		const id = sessionId(ctx);
		let state = states.get(id);
		if (!state) {
			state = {
				baseTools: uniqueNames(pi.getActiveTools()),
				prepared: false,
				minimal: false,
				transport: false,
				xdTools: [],
				xdCatalog: [],
				xdDispatchIds: new Set<string>(),
			};
			states.set(id, state);
		}
		return state;
	}


	function refreshXdTools(state: SessionState): void {
		const catalog: XdToolInfo[] = [];
		for (const tool of pi.getAllTools()) {
			if (DIRECT_TOOL_NAMES.has(tool.name)) continue;
			catalog.push({ name: tool.name, summary: toolSummary(tool.description) });
		}
		catalog.sort((left, right) => left.name.localeCompare(right.name));
		state.xdTools = catalog.map(entry => entry.name);
		state.xdCatalog = catalog;
	}

	async function prepare(ctx: ExtensionContext): Promise<SessionState> {
		const state = stateFor(ctx);
		if (state.prepared) return state;
		const available = new Set(pi.getAllTools().map(tool => tool.name));
		refreshXdTools(state);
		const missingCore = [...CORE_TOOLS].filter(name => !available.has(name));
		if (missingCore.length > 0) {
			state.minimal = false;
			state.prepared = true;
			if (!warnedMissingCore) {
				warnedMissingCore = true;
				warn(pi, `Eternal Minimal disabled: required tools unavailable (${missingCore.join(", ")}); exposing the normal catalog`);
			}
			return state;
		}
		state.transport = XD_TRANSPORT_TOOLS.every(name => available.has(name) && state.baseTools.includes(name));
		state.minimal = true;
		state.prepared = true;
		if (!state.transport && !warnedTransport) {
			warnedTransport = true;
			warn(pi, "xd:// transport is unavailable: both read and write must be active; Eternal Minimal keeps only its core tools");
		}
		try {
			await pi.setActiveTools(uniqueNames([...state.baseTools, ...CORE_TOOLS, ...(state.transport ? XD_TRANSPORT_TOOLS : [])]));
		} catch (error) {
			state.minimal = false;
			warn(pi, `Eternal Minimal tool activation failed; exposing the normal catalog: ${String(error)}`);
		}
		return state;
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		const state = states.get(sessionId(ctx));
		if (!state?.prepared) return;
		try {
			await pi.setActiveTools(state.baseTools);
		} catch (error) {
			warn(pi, `normal tool catalog restoration failed: ${String(error)}`);
		}
		state.prepared = false;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (isDeepSeek(ctx.model)) await prepare(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isDeepSeek(ctx.model)) {
			await restore(ctx);
			return;
		}
		const state = await prepare(ctx);
		if (!state.minimal) return;
		refreshXdTools(state);
		const systemPrompt = [MINIMAL_SYSTEM_PROMPT, xdInstruction(state)];
		return { systemPrompt };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		const visibleNames = state.transport ? [...CORE_TOOLS, ...XD_TRANSPORT_TOOLS] : [...CORE_TOOLS];
		return stripEternalProviderPayload(event.payload, visibleNames);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		if (event.toolName === XD_WRITE && isXdWriteInput(event.input)) {
			state.xdDispatchIds.add(event.toolCallId);
			return;
		}
		const allowed = state.transport ? [...CORE_TOOLS, ...XD_TRANSPORT_TOOLS] : [...CORE_TOOLS];
		if (allowed.includes(event.toolName)) return;
		if (state.xdDispatchIds.has(event.toolCallId)) {
			state.xdDispatchIds.delete(event.toolCallId);
			return;
		}
		return {
			block: true,
			reason: `Eternal Minimal blocks direct call to ${event.toolName}; use read/write with an xd:// path instead`,
		};
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		if (event.toolName === XD_WRITE) state.xdDispatchIds.delete(event.toolCallId);
	});

	pi.on("context", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		const messages = filterEternalContext(event.messages);
		return messages.length === event.messages.length ? undefined : { messages: messages as typeof event.messages };
	});


	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_payload, ctx) => {
			states.delete(sessionId(ctx));
		});
	}
	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(sessionId(ctx));
	});
}
