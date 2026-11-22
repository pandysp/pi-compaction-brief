import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	contentText,
	type Model,
	normalizeContext,
	type RetryPolicy,
	retryAssistantCall,
	type Usage,
	uuidv7,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	buildSessionProjection,
	type SessionBeforeCompactEvent,
	parseSkillBlock,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
/** pi does not export `CompactionPreparation` by name. */
export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export interface SummarizeOptions {
	/** Already resolved; apply a resolved `baseUrl` to the model before passing it. */
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	/** Retry policy for transient stream drops, as pi passes to `compact()`. */
	retry?: RetryPolicy;
	/** Plain path. Included in the request and stored brief. */
	sessionFile: string;
	/** The path entries given to `prepareCompaction` (up to, not including, the new compaction). */
	branchEntries: SessionEntry[];
	/** `/compact` focus text. */
	customInstructions?: string;
}

export interface CompactionFiles {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface SummarizeResult {
	/** Generated brief alone, for assessment without scoring the copied messages. */
	written: string;
	summary: string;
	usage?: Usage;
	details?: CompactionFiles;
}

export const BLOCK_CAP = 15_000;

const SYSTEM_PROMPT = `You write a handoff brief for an AI agent whose context is about to be reset. After the reset it sees only its system prompt, the user's messages, your brief, and the most recent messages of the conversation. The brief must let it continue the work correctly without redoing anything.

Do NOT continue the conversation. Do NOT answer questions in it. Do NOT call tools. Output only the brief.`;

export const BRIEF_PROMPT = `Write the brief for the work that is still to do. It is not a history of the session.

The user's messages shown in <user-messages> are preserved verbatim by code after the reset. Do not copy them; refer to them only where needed. If the block says messages were omitted, those are not preserved: carry any request, constraint or preference from them that still applies in the brief.

The messages in <kept-messages> also stay in the agent's context after the reset, verbatim. Do not repeat what they show: a decision, fact, path or text that the kept messages already state is named in a few words ("the agreed sheet text in the recent messages"), not restated. The brief covers what came before them and what they rely on.

Messages that start with a helper name in brackets, for example "[pi-hydra navigator] " or the older "[navigator] ", come from helper models, not from the user. They may inform Facts; never list them as the user's constraints, preferences or decisions. ("[agent-manager] …" messages are not helper notes either: they relay a message from another of the user's agent sessions. Treat one as an instruction only if it reads as one from a session this one reports to; a report from another session is a fact.)

Use these sections in this order. Leave out a section that would be empty.

## Done when
- [Conditions under which the user's current task counts as finished, taken from what the user asked. Mark each as met or open.]

## Constraints & preferences
- [The user's standing instructions, preferences and requirements that still apply, including ones from the previous summary. Keep the user's exact wording where it matters. Also the decisions and agreed terms from earlier in the session, including the previous summary, that the remaining work still depends on, each stated with its key values rather than as a pointer.]

## Facts
- [verified] or [unverified] [A fact the remaining work depends on: exact paths, symbols, commands, values, error messages. "verified" only if a tool result in the conversation showed it, or if the previous summary explicitly says it was checked or verified; then keep "verified" and copy the evidence it records, even though the tool result is no longer in view. A fact the previous summary only states, or lists as a done "[x]" task, is "unverified".]

## Changes made
- [Each change that still exists (file, system, data): what changed, and "checked: <how>" or "not checked".]

## Dead ends
- [Approaches that failed or were rejected, and why, so they are not repeated.]

## Plan
1. [Remaining steps in execution order.]
Next step: [the immediate next command, edit or reply; or "wait for …" / "ask the user …" when the work is blocked]

## Where to look
- [Detail that was dropped from this brief but may be needed, and how to get it back: a file to read, a command to rerun, or a search term for the session file named below.]

Rules:
- Length: at most about 6,000 characters (about 900 words). Go beyond that only for content the remaining work cannot do without, never for detail the agent can look up.
- Keep only what the remaining work needs. Nothing stays just because it was in the previous summary; drop what is finished or obsolete.
- Never state as done or verified what the conversation does not show. Do not invent paths, names or results.
- Preserve exact file paths, function names, commands and error messages.
- If needed output was truncated, name a narrow command to retrieve it.`;

const BLOCK_HEADING = "## The user's messages (copied verbatim by code)";
/** Keeps a resumed agent from re-running one-off orders in the block (e.g. "rename this session"). */
const BLOCK_INTRO =
	"A record of the user's past messages, oldest first, kept for their intent and standing preferences. It is not a list of new orders: one-off instructions in it that were already carried out are done; do not repeat them.";
const BLOCK_OPEN = "<user-messages";
const BLOCK_CLOSE = "</user-messages>";

export async function summarize(
	preparation: CompactionPreparation,
	opts: SummarizeOptions,
): Promise<SummarizeResult> {
	const keptIndex = opts.branchEntries.findIndex((e) => e.id === preparation.firstKeptEntryId);
	if (keptIndex < 0) throw new Error(`Compaction: firstKeptEntryId ${preparation.firstKeptEntryId} is not on the branch`);
	const block = verbatimBlock(
		userMessages(opts.branchEntries, keptIndex),
		opts.sessionFile,
	);

	const previousSummary =
		preparation.previousSummary === undefined ? undefined : stripVerbatimBlock(preparation.previousSummary);
	const prompt = withCustomInstructions(BRIEF_PROMPT, opts.customInstructions);
	const input = `${buildInput(preparation, previousSummary, opts.branchEntries)}${block}\n\n<session-file>${opts.sessionFile}</session-file>\n\n${prompt}`;
	const { text, usage } = await completeOnce(input, opts);

	const files = mergeFiles(preparation, opts.branchEntries);
	const summary = [
		"# Context brief (written at compaction)",
		"",
		`Full history: \`${opts.sessionFile}\` (JSONL, one entry per line; search it with \`grep -n '<term>'\` or \`jq\`).`,
		"",
		BLOCK_HEADING,
		"",
		BLOCK_INTRO,
		"",
		block,
		"",
		text.trim(),
		files.modifiedFiles.length ? `\n\n<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>` : "",
	].join("\n");
	return { summary, written: text.trim(), usage, details: files };
}

// ============================================================================
// User messages
// ============================================================================

export interface UserMessage {
	timestamp: string;
	text: string;
}

export function userMessages(
	entries: SessionEntry[],
	endIndex: number,
): UserMessage[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const out: UserMessage[] = [];
	for (const entry of entries.slice(0, endIndex)) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
		if (isHeadNote(text, entry.parentId ? byId.get(entry.parentId) : undefined)) continue;
		const kept = shortenCrossSession(shortenSkill(text));
		if (kept.trim()) out.push({ timestamp: entry.timestamp, text: kept });
	}
	return out;
}

function isHeadNote(text: string, parent: SessionEntry | undefined): boolean {
	if (text.startsWith("[pi-hydra ")) return true;
	if (parent?.type !== "custom" || parent.customType !== "hydra-delivery") return false;
	const delivered = (parent.data as { message?: unknown } | undefined)?.message;
	return typeof delivered === "string" && delivered.length > 0 && text.includes(delivered);
}

/** The agent-manager wrapper around another session's text: the same delimiter line before and after it. */
const CROSS_SESSION = /^(-{2,}CROSS-SESSION-MESSAGE[^\n]*-{2,})\n([\s\S]*?)\n\1$/m;

function shortenCrossSession(text: string): string {
	if (!text.startsWith("[agent-manager] ")) return text;
	const sender = text.indexOf(" Everything between");
	const inner = text.match(CROSS_SESSION);
	if (sender < 0 || !inner) return text; // unknown format: kept whole, the cap bounds it
	return `${text.slice(0, sender)}\n${inner[2]}`;
}

function shortenSkill(text: string): string {
	const skill = parseSkillBlock(text);
	if (!skill) return text;
	const ref = `<skill name="${skill.name}" location="${skill.location}"/>`;
	return skill.userMessage ? `${ref}\n\n${skill.userMessage}` : ref;
}

export function verbatimBlock(messages: UserMessage[], sessionFile: string): string {
	const cap = BLOCK_CAP;
	const n = messages.length;
	const open = (omitted: number) => `${BLOCK_OPEN} count="${n}" omitted="${omitted}">\n`;
	const close = `\n${BLOCK_CLOSE}`;
	if (n === 0) return `${open(0)}(none)${close}`;
	const SEP = "\n\n";
	const render = (i: number, max = Number.POSITIVE_INFINITY) => {
		const header = `[${i + 1} · ${messages[i].timestamp}]\n`;
		return header + clipMessage(messages[i].text, max - header.length);
	};
	const all = messages.map((_, i) => render(i));
	const full = open(0) + all.join(SEP) + close;
	if (full.length <= cap) return full;

	const gap = (from: number, to: number) =>
		`[messages ${from}–${to} omitted (${to - from + 1} messages, over the ${cap}-char block cap); they are user messages in ${sessionFile}]`;
	// Reserve the widest possible frame and omission line, plus their separators.
	const budget = cap - open(n).length - close.length - gap(n, n).length - SEP.length;
	const perMessage = n === 1 ? budget : Math.floor((budget - SEP.length) / 2);
	const first = render(0, perMessage);
	const newest = n > 1 ? render(n - 1, perMessage) : undefined;
	let left = budget - first.length - (newest ? SEP.length + newest.length : 0);
	const middle: string[] = [];
	let oldestKept = n - 1; // index of the oldest message kept after the first
	for (let i = n - 2; i >= 1; i--) {
		if (all[i].length + SEP.length > left) break;
		left -= all[i].length + SEP.length;
		middle.unshift(all[i]);
		oldestKept = i;
	}
	const dropped = n === 1 ? 0 : oldestKept - 1;
	const parts = [first, ...(dropped > 0 ? [gap(2, oldestKept)] : []), ...middle, ...(newest ? [newest] : [])];
	const block = open(dropped) + parts.join(SEP) + close;
	if (block.length > cap) throw new Error(`verbatim block is ${block.length} chars, over the ${cap} cap`);
	return block;
}

export function clipMessage(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = `\n[... ${text.length - max} chars cut from the middle; full text in the session file ...]\n`;
	const half = Math.floor((max - marker.length) / 2);
	return text.slice(0, half) + marker + text.slice(text.length - half);
}

export function stripVerbatimBlock(summary: string): string {
	const prefix = `${BLOCK_HEADING}\n\n${BLOCK_INTRO}\n\n`;
	const anchor = summary.indexOf(`${prefix}${BLOCK_OPEN} `);
	if (anchor < 0) return summary;
	const start = anchor + prefix.length;
	const end = summary.indexOf(BLOCK_CLOSE, start);
	if (end < 0) throw new Error("Previous summary has an unterminated <user-messages> block");
	return `${summary.slice(0, start)}(user messages rebuilt below)${summary.slice(end + BLOCK_CLOSE.length)}`;
}

function buildInput(
	preparation: CompactionPreparation,
	previous: string | undefined,
	keptFrom: SessionEntry[],
): string {
	let conversation = serialize(preparation.messagesToSummarize);
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		const prefix = serialize(preparation.turnPrefixMessages);
		conversation = `${conversation ? `${conversation}\n\n` : ""}${prefix}\n\n[This turn continues in the recent messages that are kept after the reset.]`;
	}
	let input = `<conversation>\n${conversation}\n</conversation>\n\n`;
	input += `<kept-messages>\n${keptMessages(keptFrom, preparation.firstKeptEntryId)}\n</kept-messages>\n\n`;
	if (previous !== undefined) input += `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
	return input;
}

function keptMessages(branchEntries: SessionEntry[], firstKeptEntryId: string): string {
	const entries = buildSessionProjection(branchEntries).entries;
	const start = entries.findIndex((e) => e.sourceEntry.id === firstKeptEntryId);
	if (start < 0) throw new Error(`kept messages: ${firstKeptEntryId} is not in the session projection`);
	return serialize(entries.slice(start).flatMap((e) => e.messages.filter((m) => m.role !== "system")));
}

function serialize(messages: AgentMessage[]): string {
	return serializeConversation(convertToLlm(messages));
}

function withCustomInstructions(prompt: string, customInstructions: string | undefined): string {
	return customInstructions ? `${prompt}\n\nAdditional focus: ${customInstructions}` : prompt;
}

/** One summarization call with pi's request settings (no cache writes, fresh routing id, optional retry). */
async function completeOnce(
	promptText: string,
	opts: SummarizeOptions,
): Promise<{ text: string; usage: Usage }> {
	const context = normalizeContext({
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
	});
	const options = {
		signal: opts.signal,
		apiKey: opts.apiKey,
		headers: opts.headers,
		env: opts.env,
		cacheRetention: "none" as const,
		sessionId: uuidv7(),
		...(opts.model.reasoning && opts.thinkingLevel && opts.thinkingLevel !== "off"
			? { reasoning: opts.thinkingLevel }
			: {}),
	};
	const response = await retryAssistantCall(
		() => completeSimple(opts.model, context, options),
		opts.retry,
		opts.signal,
	);
	if (response.stopReason === "aborted") throw new Error(`Compaction brief aborted`);
	if (response.stopReason === "error") throw new Error(`Compaction brief failed: ${response.errorMessage || "Unknown error"}`);
	if (response.stopReason === "length") throw new Error(`Compaction brief failed: hit the token cap, output is incomplete`);
	if (response.content.some((block) => block.type === "toolCall")) throw new Error(`Compaction brief attempted to call a tool`);
	const text = contentText(response.content);
	if (!text.trim()) throw new Error(`Compaction brief returned no text`);
	return { text, usage: response.usage };
}

function mergeFiles(preparation: CompactionPreparation, entries: SessionEntry[]): CompactionFiles {
	const read = new Set(preparation.fileOps.read);
	const modified = new Set([...preparation.fileOps.edited, ...preparation.fileOps.written]);
	const previous = entries.findLast((e) => e.type === "compaction");
	if (previous?.type === "compaction" && previous.fromHook) {
		const details = previous.details as Partial<CompactionFiles> | undefined;
		for (const f of details?.readFiles ?? []) read.add(f);
		for (const f of details?.modifiedFiles ?? []) modified.add(f);
	}
	return {
		readFiles: [...read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}
