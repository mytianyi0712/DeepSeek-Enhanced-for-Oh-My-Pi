import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * DeepSeek Enhanced.
 *
 * DeepSeek stays on a permanent minimal presentation for the whole session.
 * The provider wire payload is reduced to the shell/editor pair plus OMP's
 * native `read`/`write` transport, while the complete registry remains
 * available behind `xd://` devices.
 *
 * `xd://` is the only gateway convention here. The model reads
 * `xd://<tool>` for its schema and writes the JSON arguments to the same URL;
 * OMP then performs the real validation, approval, execution, and rendering.
 * There is no extra command alias or compatibility middleware.
 *
 * The oh-we-need anchor prompt is attached to the first request of every
 * session and is re-injected when the model's chain-of-thought shows
 * regression signals (many "but", "wait", "let me", ...).
 */

const STR_REPLACE_EDITOR = "str_replace_editor";
const BASH = "bash";
const XD_READ = "read";
const XD_WRITE = "write";
const CORE_TOOLS = [BASH, STR_REPLACE_EDITOR] as const;
const XD_TRANSPORT_TOOLS = [XD_READ, XD_WRITE] as const;
const DIRECT_TOOL_NAMES = new Set<string>([...CORE_TOOLS, ...XD_TRANSPORT_TOOLS]);
const EXTENSION_NAME = "deepseek-enhanced";
const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";
function buildAnchorPrompt(xdTools: readonly string[], xdCatalog: readonly XdToolInfo[]): string {
	const highOrderLine =
		xdTools.length > 0
			? `Registered high-order tools accessible through xd:// when mounted:\n${formatXdCatalog(xdCatalog)}`
			: "No additional high-order tools are currently registered; run read with path `xd://` to list mounted devices.";
	return `**First sentence rule (mandatory, highest priority; first rule of this prompt): the first sentence inside \`<think>\` must open with \`We need to ...\` / \`We need ...\`. Following sentences keep \`We need to ...\` / \`We need ...\` as the core pattern, one concrete action each, and may interleave I'll (next action) · I can (viable option) · I should (what ought to be done) · I will (committed step).**

You are a helpful software engineer assistant. We need to follow this style for all internal reasoning (chain-of-thought):

1. **\`We need to ...\` / \`We need ...\` is the core pattern for every following sentence.** Either can open any sentence, not only the first. We need one concrete action per sentence. Interleave modal verbs: I'll (next action) · I can (viable option) · I need (what must be done) · I should (what ought to be done) · I will (committed step) · I'm / I am (what I am about to do).
2. **Avoid \`let me ...\`.** We need to prefer \`We need to ...\` / \`We need ...\` for opening steps.
3. **Short and colloquial.** We need one sentence per step, decision-level summaries only, We / I perspective.
4. **Classify every task first.** We need to pick a stable end: build (produce, verify, fix) · fix (read, locate, minimal change, verify) · weak (classify first, then build or fix).
5. **Think tag.** We need each reasoning step written inside the thinking tag: \`<think>We need to ...</think>\`. Never output \`<think>\` tags or reasoning text in the final reply.
6. **Scope.** We need this to shape reasoning only. Final replies follow the user's language and tone.

**xd:// high-order tools.** Only bash, str_replace_editor, read, and write are directly callable. Other high-order tools must be reached through xd://: read \`xd://<tool>\` for docs and JSON schema, then write \`xd://<tool>\` with one JSON args object. ${highOrderLine}`;
}
const ALLOWED_CUSTOM_TYPES: Record<string, true> = { "skill-prompt": true };
const STR_REPLACE_EDITOR_DESCRIPTION =
	"Custom editing tool for viewing, creating and editing files. Commands: view, create, str_replace, insert. Use absolute paths. old_str must be unique.";

type EditorParams = {
	command: "view" | "create" | "str_replace" | "insert";
	path: string;
	file_text?: string;
	insert_line?: number;
	new_str?: string;
	old_str?: string;
	view_range?: number[];
};

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
	firstRoundDone: boolean;
	lastAnchorAssistantIndex: number;
	anchorCooldownUntil: number;
};

function editorPath(path: string): string {
	if (path.trim().length === 0) throw new Error("path must be a non-empty string");
	if (!isAbsolute(path)) throw new Error(`The path ${path} is not an absolute path`);
	return path;
}

function clipEditorOutput(text: string): string {
	return text.length <= 16_000 ? text : `${text.slice(0, 16_000)}<response clipped>`;
}

async function viewEditorPath(path: string, viewRange?: number[]): Promise<string> {
	const target = editorPath(path);
	const info = await stat(target);
	if (info.isDirectory()) {
		if (viewRange !== undefined) throw new Error("view_range is not allowed for directories");
		const rows: string[] = [`d\t${target}`];
		async function visit(directory: string, depth: number): Promise<void> {
			if (depth > 2) return;
			const entries = (await readdir(directory, { withFileTypes: true }))
				.filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "__pycache__")
				.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const child = `${directory.replace(/[\\/]$/, "")}/${entry.name}`;
				rows.push(`${entry.isDirectory() ? "d" : "f"}\t${child}`);
				if (entry.isDirectory()) await visit(child, depth + 1);
			}
		}
		await visit(target, 1);
		return `Here're the files and directories up to 2 levels deep in ${target}:\n${clipEditorOutput(rows.join("\n") + "\n")}`;
	}
	if (!info.isFile()) throw new Error(`cannot view ${target}: not a regular file or directory`);
	const content = await readFile(target, "utf8");
	const allLines = content.split("\n");
	let initialLine = 1;
	let finalLine: number | undefined;
	if (viewRange !== undefined) {
		if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
			throw new Error("Invalid view_range. It should be two integers.");
		}
		initialLine = viewRange[0];
		finalLine = viewRange[1];
		if (
			initialLine < 1 ||
			initialLine > allLines.length ||
			finalLine === undefined ||
			finalLine > allLines.length ||
			(finalLine !== -1 && finalLine < initialLine)
		) {
			throw new Error(`Invalid view_range: [${viewRange.join(", ")}].`);
		}
	}
	const lines =
		finalLine === undefined
			? allLines
			: finalLine === -1
				? allLines.slice(initialLine - 1)
				: allLines.slice(initialLine - 1, finalLine);
	const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
	const range = finalLine === undefined ? "" : ` with view_range=[${initialLine}, ${finalLine}]`;
	return clipEditorOutput(
		`Here's the content of ${target} with line numbers (which has a total of ${allLines.length} lines)${range}:\n${numbered}\n`,
	);
}

async function createEditorFile(path: string, fileText: string | undefined): Promise<string> {
	const target = editorPath(path);
	if (fileText === undefined) throw new Error("Parameter file_text is required for command: create");
	try {
		await stat(target);
		throw new Error(`File already exists at: ${target}. Cannot overwrite files using command create.`);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") throw error;
	}
	await writeFile(target, fileText, "utf8");
	return `New file created successfully at: ${target}`;
}

async function replaceEditorText(path: string, oldStr: string | undefined, newStr: string | undefined): Promise<string> {
	const target = editorPath(path);
	if (!oldStr) throw new Error("Parameter old_str is required and must not be empty for command: str_replace");
	const before = await readFile(target, "utf8");
	const offsets: number[] = [];
	let cursor = 0;
	while (true) {
		const match = before.indexOf(oldStr, cursor);
		if (match < 0) break;
		offsets.push(match);
		cursor = match + oldStr.length;
	}
	if (offsets.length === 0) throw new Error(`No replacement was performed, old_str did not appear verbatim in ${target}.`);
	if (offsets.length > 1) throw new Error(`No replacement was performed. Multiple occurrences of old_str in ${target}.`);
	const match = offsets[0];
	await writeFile(target, before.slice(0, match) + (newStr ?? "") + before.slice(match + oldStr.length), "utf8");
	return `The file ${target} has been edited successfully.`;
}

async function insertEditorText(path: string, insertLine: number | undefined, newStr: string | undefined): Promise<string> {
	const target = editorPath(path);
	if (insertLine === undefined) throw new Error("Parameter insert_line is required for command: insert");
	if (newStr === undefined) throw new Error("Parameter new_str is required for command: insert");
	const before = await readFile(target, "utf8");
	const lines = before.split("\n");
	if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
		throw new Error(`Invalid insert_line parameter: ${insertLine}.`);
	}
	await writeFile(target, [...lines.slice(0, insertLine), ...newStr.split("\n"), ...lines.slice(insertLine)].join("\n"), "utf8");
	return `The file ${target} has been edited successfully.`;
}

function registerStrReplaceEditor(pi: ExtensionAPI): void {
	pi.registerTool({
		name: STR_REPLACE_EDITOR,
		label: "String Replace Editor",
		description: STR_REPLACE_EDITOR_DESCRIPTION,
		defaultInactive: true,
		loadMode: "essential",
		parameters: pi.zod.object({
			command: pi.zod.enum(["view", "create", "str_replace", "insert"]),
			path: pi.zod.string(),
			file_text: pi.zod.string().optional(),
			insert_line: pi.zod.number().int().optional(),
			new_str: pi.zod.string().optional(),
			old_str: pi.zod.string().optional(),
			view_range: pi.zod.array(pi.zod.number().int()).optional(),
		}),
		async execute(_id: string, params: EditorParams, signal: AbortSignal | undefined) {
			if (signal?.aborted) throw new Error("Tool call aborted");
			switch (params.command) {
				case "view":
					return { content: [{ type: "text", text: await viewEditorPath(params.path, params.view_range) }] };
				case "create":
					return { content: [{ type: "text", text: await createEditorFile(params.path, params.file_text) }] };
				case "str_replace":
					return { content: [{ type: "text", text: await replaceEditorText(params.path, params.old_str, params.new_str) }] };
				case "insert":
					return { content: [{ type: "text", text: await insertEditorText(params.path, params.insert_line, params.new_str) }] };
			}
		},
	});
}

function uniqueNames(names: readonly string[]): string[] {
	return [...new Set(names.filter(name => typeof name === "string" && name.length > 0))];
}

function recordValue(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function assistantText(message: unknown): string {
	const record = recordValue(message);
	if (!record) return "";
	const parts: string[] = [];
	if (typeof record.reasoning === "string") parts.push(record.reasoning);
	if (typeof record.reasoning_content === "string") parts.push(record.reasoning_content);
	if (typeof record.thinking === "string") parts.push(record.thinking);
	const content = record.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const blockRecord = recordValue(block);
			if (!blockRecord) continue;
			if (blockRecord.type === "thinking" && typeof blockRecord.thinking === "string") {
				parts.push(blockRecord.thinking);
			} else if (blockRecord.type === "reasoning" && typeof blockRecord.reasoning === "string") {
				parts.push(blockRecord.reasoning);
			}
		}
	} else if (typeof content === "string") {
		parts.push(content);
	}
	return parts.join("\n");
}

function countMatches(text: string, pattern: RegExp): number {
	const matches = text.match(pattern);
	return matches ? matches.length : 0;
}

// Chain-of-thought regression heuristic. "but", "wait" and "let me" are normal
// in small amounts, so only a sustained burst triggers a re-anchor.
function regressionScore(text: string): number {
	if (!text) return 0;
	let score = 0;
	score += countMatches(text, /\bwait\b/gi) * 2;
	score += countMatches(text, /\blet me\b/gi) * 1;
	score += countMatches(text, /\blet's\b|\blets\b/gi) * 1;
	score += countMatches(text, /\bbut\b/gi) * 0.5;
	score += countMatches(text, /\bhold on\b|\bhmm\b/gi) * 1.5;
	return score;
}

const REGRESSION_THRESHOLD = 6;

function lastAssistantIndex(messages: readonly unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = recordValue(messages[index]);
		if (message && message.role === "assistant") return index;
	}
	return -1;
}

function appendTextToContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return `${content}\n\n${text}`;
	if (Array.isArray(content)) return [...content, { type: "text", text }];
	return text;
}

function contentContainsAnchor(content: unknown): boolean {
	const marker = "First sentence rule (mandatory";
	const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
	return raw.includes(marker);
}

function toolSummary(description: string | undefined): string {
	if (!description) return "";
	const firstLine = description.split("\n").find(line => line.trim().length > 0);
	const text = (firstLine ?? description).trim();
	return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

function formatXdCatalog(catalog: readonly XdToolInfo[]): string {
	return catalog.map(entry => `- ${entry.name}${entry.summary ? ` — ${entry.summary}` : ""}`).join("\n");
}

function injectAnchorIntoMessages(messages: readonly unknown[], xdTools: readonly string[], xdCatalog: readonly XdToolInfo[]): unknown[] {
	const anchor = buildAnchorPrompt(xdTools, xdCatalog);
	const result = messages.slice();
	for (let index = result.length - 1; index >= 0; index -= 1) {
		const message = recordValue(result[index]);
		if (!message || message.role !== "user") continue;
		result[index] = { ...message, content: appendTextToContent(message.content, anchor) };
		return result;
	}
	return [...result, { role: "user", content: anchor }];
}

function messagesContainAnchor(messages: readonly unknown[]): boolean {
	return messages.some(message => {
		const record = recordValue(message);
		return record !== undefined && contentContainsAnchor(record.content);
	});
}

function isXdWriteInput(input: unknown): boolean {
	const record = recordValue(input);
	return typeof record?.path === "string" && record.path.startsWith("xd://");
}

function modelKey(model: ExtensionContext["model"]): string {
	if (!model) return "";
	return [model.provider, model.id, model.name].filter(value => typeof value === "string").join("/").toLowerCase();
}

function isDeepSeek(model: ExtensionContext["model"]): boolean {
	return modelKey(model).includes("deepseek");
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "unknown-session";
	}
}

function warn(pi: ExtensionAPI, message: string): void {
	try {
		pi.logger?.warn(`[${EXTENSION_NAME}] ${message}`);
	} catch {
		// Diagnostics must never affect the agent loop.
	}
}

function stripDateCwdText(content: string): { content: string; changed: boolean } {
	if (!content.startsWith("<system-reminder>\nToday:")) return { content, changed: false };
	const end = content.indexOf("</system-reminder>");
	if (end < 0 || !content.slice(0, end).includes("current working directory:")) {
		return { content, changed: false };
	}
	const remainder = content.slice(end + "</system-reminder>".length);
	return { content: remainder.startsWith("\n\n") ? remainder.slice(2) : remainder, changed: true };
}

function stripDateCwdReminder(content: unknown): { content: unknown; changed: boolean } {
	if (typeof content === "string") return stripDateCwdText(content);
	if (!Array.isArray(content)) return { content, changed: false };
	let changed = false;
	const blocks = content.map(block => {
		const record = recordValue(block);
		if (!record || record.type !== "text" || typeof record.text !== "string") return block;
		const cleaned = stripDateCwdText(record.text);
		if (!cleaned.changed) return block;
		changed = true;
		return { ...record, text: cleaned.content };
	});
	return { content: changed ? blocks : content, changed };
}

function extractToolName(tool: unknown): string | undefined {
	const toolRecord = recordValue(tool);
	const functionRecord = toolRecord ? recordValue(toolRecord.function) : undefined;
	if (typeof functionRecord?.name === "string") return functionRecord.name;
	return typeof toolRecord?.name === "string" ? toolRecord.name : undefined;
}

function stripEternalProviderPayload(payload: unknown, visibleNames: readonly string[]): unknown {
	const root = recordValue(payload);
	if (!root) return payload;
	let changed = false;
	let tools = root.tools;
	if (Array.isArray(tools)) {
		const allowed = new Set(visibleNames);
		const filtered = tools.filter(tool => {
			const name = extractToolName(tool);
			return name !== undefined && allowed.has(name);
		});
		changed = filtered.length !== tools.length || filtered.some((tool, index) => tool !== tools[index]);
		tools = filtered;
	}
	const messages = Array.isArray(root.messages)
		? root.messages.map(message => {
			const messageRecord = recordValue(message);
			if (!messageRecord || messageRecord.role !== "user") return message;
			const cleaned = stripDateCwdReminder(messageRecord.content);
			if (!cleaned.changed) return message;
			changed = true;
			return { ...messageRecord, content: cleaned.content };
		})
		: root.messages;
	const thinking = recordValue(root.thinking);
	const needsThinking = thinking?.type !== "enabled";
	const needsTokenCap = root.max_completion_tokens !== 256000 || root.max_tokens !== 256000;
	if (needsThinking || needsTokenCap) changed = true;
	if (!changed) return payload;
	return {
		...root,
		...(Array.isArray(root.tools) ? { tools } : {}),
		...(Array.isArray(root.messages) ? { messages } : {}),
		max_completion_tokens: 256000,
		max_tokens: 256000,
		thinking: { type: "enabled" },
	};
}

function filterEternalContext(messages: readonly unknown[]): unknown[] {
	return messages.filter(message => {
		const record = recordValue(message);
		if (!record) return true;
		if (record.role === "custom" || record.role === "hookMessage") {
			const customType = typeof record.customType === "string" ? record.customType : undefined;
			return customType !== undefined && ALLOWED_CUSTOM_TYPES[customType] === true;
		}
		if (record.role === "user" && record.attribution === "agent") return false;
		return true;
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
	const direct = state.transport ? "bash, str_replace_editor, read, and write" : "bash and str_replace_editor";
	return [
		`This is Eternal Minimal: the only directly callable tools are ${direct}.`,
		"Do not call any other tool name directly, even if it appears familiar; use the xd:// transport for every non-core capability.",
		...transport,
		"",
		"For every high-order tool above, first read `xd://<tool>` to get its exact docs and JSON schema, then write `xd://<tool>` with one JSON args object to execute it.",
		"If the tool you need is not listed, run read with path `xd://` to discover the currently mounted devices.",
		"If you need user input or confirmation, use the ask tool through xd:// when it is mounted.",
		"Use bash and str_replace_editor directly for shell and file work. OMP performs the real xd:// schema validation, approval, execution, and rendering.",
		"Example: read {\"path\": \"xd://ask\"} to fetch ask's schema, then write {\"path\": \"xd://ask\", \"content\": \"{\\\"questions\\\":[{\\\"id\\\":\\\"confirm\\\",\\\"question\\\":\\\"Proceed?\\\",\\\"options\\\":[{\\\"label\\\":\\\"Yes\\\"},{\\\"label\\\":\\\"No\\\"}]}]}\"} to execute it.",
	].join("\n");
}

export default function registerDeepSeekEnhanced(pi: ExtensionAPI): void {
	registerStrReplaceEditor(pi);
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
				firstRoundDone: false,
				lastAnchorAssistantIndex: -1,
				anchorCooldownUntil: 0,
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

	// This is the permanent request boundary. There is no promotion or epoch
	// reset: every DeepSeek request gets the same minimal prompt and transport.
	// The anchor is injected invisibly in the context event, not into the user's
	// visible input or system prompt.
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

	// Final wire-level guard. It protects thinking steps, compaction, retries,
	// and provider-specific request rebuilds from reintroducing the full catalog.
	// It also watches for chain-of-thought regression and re-injects the anchor
	// prompt on the next request (after a tool call or on the user's next message).
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		const visibleNames = state.transport ? [...CORE_TOOLS, ...XD_TRANSPORT_TOOLS] : [...CORE_TOOLS];
		const root = recordValue(event.payload);
		if (!root) return stripEternalProviderPayload(event.payload, visibleNames);
		let payload = root;
		let messages = Array.isArray(payload.messages) ? payload.messages : [];
		if (!messagesContainAnchor(messages)) {
			messages = injectAnchorIntoMessages(messages, state.xdTools, state.xdCatalog);
			payload = { ...payload, messages };
		}
		state.firstRoundDone = true;
		const assistantIndex = lastAssistantIndex(messages);
		if (
			assistantIndex >= 0 &&
			assistantIndex !== state.lastAnchorAssistantIndex &&
			assistantIndex >= state.anchorCooldownUntil
		) {
			const text = assistantText(messages[assistantIndex]);
			if (regressionScore(text) >= REGRESSION_THRESHOLD && !messagesContainAnchor(messages)) {
				state.lastAnchorAssistantIndex = assistantIndex;
				state.anchorCooldownUntil = assistantIndex + 3;
				payload = { ...payload, messages: injectAnchorIntoMessages(messages, state.xdTools, state.xdCatalog) };
			}
		}
		return stripEternalProviderPayload(payload, visibleNames);
	});

	// Runtime guard: a stale model context or provider adapter must not turn
	// an unlisted Standard tool name into a real execution. Nested xd:// device
	// dispatches carry the same toolCallId as the originating write call, so a
	// pending xd write ID lets the inner tool execute while direct calls to
	// high-order tools remain blocked.
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

	// Keep automatic context out permanently. User skill gestures remain valid.
	// The anchor is appended here as a hidden provider-only user message: the
	// session transcript is untouched, slash commands are not rewritten, and the
	// system prompt stays byte-stable for prefix caching.
	pi.on("context", (event, ctx) => {
		if (!isDeepSeek(ctx.model)) return;
		const state = states.get(sessionId(ctx));
		if (!state?.minimal) return;
		refreshXdTools(state);
		let messages = filterEternalContext(event.messages);
		if (!messagesContainAnchor(messages)) {
			messages = [...messages, { role: "user", content: [{ type: "text", text: buildAnchorPrompt(state.xdTools, state.xdCatalog) }] }];
		}
		state.firstRoundDone = true;
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
