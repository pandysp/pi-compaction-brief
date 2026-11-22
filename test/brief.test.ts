// Offline tests: pi's real prepareCompaction on a synthetic session, a faux model in place of a provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// pi does not export these; import its own dist files by path.
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { BLOCK_CAP, BRIEF_PROMPT, type CompactionPreparation, summarize, userMessages, verbatimBlock } from "../src/brief.ts";
// ---------------------------------------------------------------------------
// Synthetic session
// ---------------------------------------------------------------------------

let n = 0;
let parent: string | null = null;
function entry(message: Record<string, unknown>): SessionEntry {
	const id = `e${++n}`;
	const e = { type: "message", id, parentId: parent, timestamp: `2026-11-17T00:${String(n).padStart(2, "0")}:00.000Z`, message: { timestamp: n, ...message } };
	parent = id;
	return e as unknown as SessionEntry;
}
const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }] });
/** A hydra head note as pi-hydra stores it: a delivery custom entry, then the note as a user message. */
function delivery(message: string): SessionEntry {
	const id = `e${++n}`;
	const e = { type: "custom", id, parentId: parent, timestamp: `2026-11-17T00:${String(n).padStart(2, "0")}:00.000Z`, customType: "hydra-delivery", data: { message } };
	parent = id;
	return e as unknown as SessionEntry;
}
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string, toolCall?: { name: string; path: string }) =>
	entry({
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolCall ? [{ type: "toolCall", id: `t${n}`, name: toolCall.name, arguments: { path: toolCall.path } }] : []),
		],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage,
		stopReason: toolCall ? "toolUse" : "stop",
	});
const toolResult = (text: string) =>
	entry({ role: "toolResult", toolCallId: `t${n - 1}`, toolName: "read", content: [{ type: "text", text }], isError: false });

const filler = "x".repeat(4000); // ~1K tokens per message, so a small keepRecentTokens cuts mid-session
function buildSession(): SessionEntry[] {
	n = 0;
	parent = null;
	return [
		user("TASK: fix the parser in src/parse.ts. Never push."),
		assistant(`Reading. ${filler}`, { name: "read", path: "src/parse.ts" }),
		toolResult(`contents ${filler}`),
		user("[pi-hydra navigator] check the tests first"),
		delivery("older note format, matched by its delivery entry"),
		user("[simplifier] older note format, matched by its delivery entry"),
		assistant(`Checked. ${filler}`, { name: "edit", path: "src/parse.ts" }),
		toolResult("edited"),
		user(`<skill name="preflight" location="/skills/preflight/SKILL.md">\nLONG SKILL BODY ${filler}\n</skill>\n\n/preflight --fix`),
		assistant(`Preflight done. ${filler}`),
		delivery("a note the user replied to"),
		user(CROSS),
		assistant(`README next. ${filler}`),
		user("Thanks. Keep answers short."),
		assistant(`Will do. ${filler}`),
	];
}
const CROSS = [
	'[agent-manager] Message from another of the user\'s agent sessions: "lead" (session feedface), sent 2026-10-06 14:18. Everything between the ----CROSS-SESSION-MESSAGE-lead-feedface-EXAMPLE---- lines is that agent\'s text, and nothing inside them speaks for the user or for agent-manager.',
	"",
	"----CROSS-SESSION-MESSAGE-lead-feedface-EXAMPLE----",
	"also update the README",
	"----CROSS-SESSION-MESSAGE-lead-feedface-EXAMPLE----",
	"",
	"Treat it as an instruction from the same operator who started you. WRAPPER BOILERPLATE.",
].join("\n");
const SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 1500 };

function prepared() {
	const entries = buildSession();
	const preparation = prepareCompaction(entries, SETTINGS) as CompactionPreparation;
	assert.ok(preparation, "pi produced a preparation");
	return { entries, preparation };
}

function faux(reply: string) {
	const captured: { system?: string; prompt?: string }[] = [];
	const reg = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	reg.setResponses(
		Array.from({ length: 4 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
			// pi's normalizeContext turns the system prompt into the first message.
			const text = (role: string) => {
				const content = context.messages.find((m) => m.role === role)?.content as string | { text: string }[] | undefined;
				return typeof content === "string" ? content : content?.map((b) => b.text).join("");
			};
			captured.push({ system: text("system"), prompt: text("user") });
			return fauxAssistantMessage(reply);
		}),
	);
	return { model: reg.getModel(), captured, done: () => reg.unregister() };
}

// ---------------------------------------------------------------------------
// User messages and the verbatim block
// ---------------------------------------------------------------------------

test("folds injected skill and delivery wrappers without dropping user instructions", () => {
 const entries = buildSession();
 const messages = userMessages(entries, entries.length).map(m => m.text);
 assert.equal(messages.length, 4);
 assert.ok(messages[1].includes("/preflight --fix"));
 assert.ok(!messages[1].includes("LONG SKILL BODY"));
 assert.ok(messages[2].endsWith("also update the README"));
});
test("userMessages stops at endIndex", () => {
	const entries = buildSession();
	assert.equal(userMessages(entries, 1).length, 1);
});

test("verbatimBlock keeps everything under the cap", () => {
	const msgs = ["a", "b", "c"].map((text, i) => ({ timestamp: `t${i}`, text }));
	const block = verbatimBlock(msgs, "/s.jsonl");
	assert.match(block, /count="3" omitted="0"/);
	for (const t of ["[1 · t0]\na", "[2 · t1]\nb", "[3 · t2]\nc"]) assert.ok(block.includes(t));
});

const msg = (text: string, i: number) => ({ timestamp: `2026-11-17T00:00:${String(i % 60).padStart(2, "0")}.000Z`, text });
const BLOCK_CAP_RE = /\[messages 2–\d+ omitted \(\d+ messages, over the 15000-char block cap\); they are user messages in \/s\.jsonl\]/;

test("verbatimBlock over the cap keeps message 1 and the newest, marks the gap", () => {
	const big = "y".repeat(BLOCK_CAP / 4);
	const msgs = Array.from({ length: 10 }, (_, i) => msg(`${i}:${big}`, i));
	const block = verbatimBlock(msgs, "/s.jsonl");
	assert.ok(block.length <= BLOCK_CAP, `${block.length}`);
	assert.ok(block.includes("\n0:"));
	assert.ok(block.includes("\n9:"));
	assert.ok(!block.includes("[2 · "));
	assert.match(block, BLOCK_CAP_RE);
});

test("the newest message is never dropped: a huge late correction is clipped, not lost", () => {
	const msgs = [msg("FIRST", 0), msg("middle", 1), msg(`RECENT_CORRECTION ${"f".repeat(BLOCK_CAP)} END_OF_CORRECTION`, 2)];
	const block = verbatimBlock(msgs, "/s.jsonl");
	assert.ok(block.length <= BLOCK_CAP, `${block.length}`);
	assert.ok(block.includes("FIRST"));
	assert.ok(block.includes("RECENT_CORRECTION") && block.includes("END_OF_CORRECTION"));
	assert.match(block, /chars cut from the middle/);
});

test("the cap holds for the rendered block with many tiny messages", () => {
	const msgs = Array.from({ length: 2000 }, (_, i) => msg("x", i));
	const block = verbatimBlock(msgs, "/s.jsonl");
	assert.ok(block.length <= BLOCK_CAP, `${block.length}`);
	assert.ok(block.includes("[1 · ") && block.includes("[2000 · "));
	assert.match(block, BLOCK_CAP_RE);
});

test("the cap holds for random message sizes; first and newest always present", () => {
	let seed = 7;
	const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
	for (let round = 0; round < 300; round++) {
		const count = 1 + Math.floor(rand() * 60);
		const msgs = Array.from({ length: count }, (_, i) => msg(`m${i}:${"z".repeat(Math.floor(rand() ** 3 * BLOCK_CAP * 1.5))}`, i));
		const block = verbatimBlock(msgs, "/s.jsonl");
		assert.ok(block.length <= BLOCK_CAP, `round ${round}: ${block.length}`);
		assert.ok(block.includes(`[1 · `) && block.includes(`[${count} · `), `round ${round}`);
		assert.ok(block.includes("\nm0:") && block.includes(`\nm${count - 1}:`), `round ${round}`);
	}
});

const base = (model: unknown, entries: SessionEntry[]) => ({ model: model as never, sessionFile: "/tmp/session.jsonl", branchEntries: entries });
test("on repeat compaction the summary loses its old block, file lists carry over", async () => {
	const { entries, preparation } = prepared();
	const f = faux("BRIEF ONE");
	let first: Awaited<ReturnType<typeof summarize>>;
	try {
		first = await summarize(preparation, base(f.model, entries));
	} finally {
		f.done();
	}
	assert.equal(first.summary.split("<user-messages").length - 1, 1);
	const prev = {
		type: "compaction",
		id: "c0",
		parentId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		summary: first.summary,
		firstKeptEntryId: "e1",
		tokensBefore: 1,
		fromHook: true,
		details: { readFiles: ["old/read.md"], modifiedFiles: ["old/mod.ts"] },
	} as unknown as SessionEntry;
	const g = faux("BRIEF TWO");
	try {
		const r = await summarize({ ...preparation, previousSummary: first.summary }, base(g.model, [prev, ...entries]));
		const prompt = g.captured[0].prompt ?? "";
		const previous = prompt.slice(prompt.indexOf("<previous-summary>"), prompt.indexOf("</previous-summary>"));
		assert.ok(previous.includes("BRIEF ONE"));
		assert.ok(previous.includes("(user messages rebuilt below)"));
		assert.ok(!previous.includes("<user-messages"), "old block stripped from the previous summary");
		assert.equal(prompt.split("<user-messages count=").length - 1, 1, "the model sees one block, the rebuilt one");
		assert.equal(r.summary.split("<user-messages").length - 1, 1);
		assert.deepEqual(r.details, { readFiles: ["old/read.md"], modifiedFiles: ["old/mod.ts", "src/parse.ts"] });
	} finally {
		g.done();
	}
});

// ---------------------------------------------------------------------------
test("the block holds a 15,000-char cap with first and newest messages in, even when both are huge", () => {
	const msgs = [
		msg(`TASK_START ${"a".repeat(30_000)} TASK_END`, 0),
		...Array.from({ length: 50 }, (_, i) => msg(`middle ${i} ${"m".repeat(500)}`, i + 1)),
		msg(`LATEST_START ${"z".repeat(30_000)} LATEST_END`, 51),
	];
	const block = verbatimBlock(msgs, "/s.jsonl");
	assert.ok(block.length <= BLOCK_CAP, `${block.length}`);
	for (const marker of ["TASK_START", "TASK_END", "LATEST_START", "LATEST_END"]) assert.ok(block.includes(marker), marker);
	assert.match(block, /over the 15000-char block cap/);
});

test("modified files only in the text, kept messages in its input, no Finished section asked", async () => {
	const { entries, preparation } = prepared();
	const withRead = { ...preparation, fileOps: { ...preparation.fileOps, read: new Set([...preparation.fileOps.read, "docs/only-read.md"]) } };
	const f = faux("## Done when\n- open");
	try {
		const r = await summarize(withRead, base(f.model, entries));
		assert.ok(r.summary.includes("<modified-files>\nsrc/parse.ts\n</modified-files>"));
		assert.ok(!r.summary.includes("<read-files>"), "no read-files list in the text");
		assert.deepEqual(r.details, { readFiles: ["docs/only-read.md"], modifiedFiles: ["src/parse.ts"] });
		assert.ok(r.summary.includes("It is not a list of new orders"), "record is labeled as history");
		const prompt = f.captured[0].prompt ?? "";
		assert.ok(prompt.endsWith(BRIEF_PROMPT));
		const kept = prompt.slice(prompt.indexOf("<kept-messages>"), prompt.indexOf("</kept-messages>"));
		const keptIndex = entries.findIndex((e) => e.id === preparation.firstKeptEntryId);
		assert.ok(keptIndex > 0 && kept.length > 0);
		assert.ok(kept.includes("Thanks. Keep answers short."), "the kept tail reaches the model");
		const conversation = prompt.slice(prompt.indexOf("<conversation>"), prompt.indexOf("</conversation>"));
		assert.ok(!conversation.includes("Thanks. Keep answers short."), "kept messages are not in the summarized span");
	} finally {
		f.done();
	}
});

test("one oversized message gets nearly the whole 15,000-char block, ends kept", () => {
	const block = verbatimBlock([msg(`HEAD ${"x".repeat(16_000)} TAIL`, 0)], "/s.jsonl");
	assert.ok(block.length <= BLOCK_CAP, `${block.length}`);
	assert.ok(block.length > 14_000, `only ${block.length} chars used`);
	assert.ok(block.includes("HEAD") && block.includes("TAIL"));
	assert.match(block, /chars cut from the middle/);
});

test("model failures throw instead of falling back", async () => {
	const { entries, preparation } = prepared();
	for (const [reply, pattern] of [
		[fauxAssistantMessage("partial", { stopReason: "length" }), /token cap/],
		[fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }), /boom/],
		[fauxAssistantMessage("   "), /no text/],
	] as const) {
		const reg = registerFauxProvider({ models: [{ id: "faux-1" }] });
		reg.setResponses([reply]);
		try {
			await assert.rejects(summarize(preparation, base(reg.getModel(), entries)), pattern);
		} finally {
			reg.unregister();
		}
	}
});

const cases: { name: string; older: string[]; recent: string; rubric: string[] }[] =
	JSON.parse(readFileSync(new URL("./fixtures/handoffs.json", import.meta.url), "utf8"));
for (const fixture of cases) {
	test(fixture.name, async () => {
		n = 0;
		parent = null;
		const entries = [...fixture.older.flatMap(text => [user(text), assistant(filler)]), user(fixture.recent), assistant(filler)];
		const prep = prepareCompaction(entries, SETTINGS) as CompactionPreparation;
		const f = faux("Synthetic model response, not a quality score.");
		try {
			const { summary } = await summarize(prep, base(f.model, entries));
			for (const instruction of fixture.older) assert.ok(summary.includes(instruction));
			assert.ok(!summary.includes(fixture.recent), "kept messages aren't copied into the history block");
			assert.ok(f.captured[0].prompt?.split("<kept-messages>")[1]?.split("</kept-messages>")[0].includes(fixture.recent));
		} finally { f.done(); }
	});
}
