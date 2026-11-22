import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { summarize } from "./brief.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		// Opt-out for one session: start pi with PI_COMPACTION_BRIEF=off and pi's own compaction runs, with every other
		// extension still loaded (`pi -ne` would switch all extensions off). An explicit choice, not a fallback.
		if (process.env.PI_COMPACTION_BRIEF === "off") return undefined;
		const { preparation, branchEntries, customInstructions, signal } = event;
		try {
			const selected = ctx.model;
			if (!selected) throw new Error("no model selected");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected);
			if (!auth.ok) throw new Error(`no credentials for ${selected.provider}/${selected.id}: ${auth.error}`);
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("session has no file (in-memory session); the brief needs its path");

			const result = await summarize(preparation, {
				model: auth.baseUrl ? { ...selected, baseUrl: auth.baseUrl } : selected,
				apiKey: auth.apiKey,
				// null marks a header to delete; pi strips those the same way before its own summary call.
				headers: auth.headers && Object.fromEntries(Object.entries(auth.headers).filter((h): h is [string, string] => h[1] !== null)),
				env: auth.env,
				thinkingLevel: ctx.thinkingLevel,
				signal,
				retry: SettingsManager.create(ctx.cwd).getRetrySettings(),
				sessionFile,
				branchEntries,
				customInstructions,
			});
			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: result.usage,
					details: result.details,
				},
			};
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Compaction brief failed, compaction cancelled (no fallback to pi's default): ${message}`, "error");
			}
			return { cancel: true };
		}
	});
}
