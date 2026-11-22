# pi-compaction-brief

When a saved [pi](https://pi.dev) conversation gets too long, keep the user's requests in their own words and give the next turn a brief about unfinished work. This extension replaces the summary used by `/compact` and automatic compaction. It uses the session's selected model; there is no second provider to configure.

## Install

```sh
pi install git:github.com/pandysp/pi-compaction-brief@v0.1.0
```

Start a new session or `/reload`. Use a **saved** session, not `--no-session`. If you previously installed a loose copy, disable that copy first; use one compaction handler at a time.

## What survives a reset?

Suppose you said *“Use SQLite”* and later *“Correction: use Postgres. The migration is still pending.”* If both messages are before the cut and fit, both appear in the copied history. The brief should distinguish the current decision (Postgres) from the abandoned one (SQLite). Copying the words is deterministic; interpreting them correctly is still the model's job.

- The user-message block is capped at **15,000 characters**, including its markers. Over the cap, keep the first and newest messages, clip long pastes in the middle, and mark gaps. Injected Hydra notes are excluded; recognized skill and cross-session wrappers are shortened.
- The model sees the older conversation, the previous brief if any, and the recent messages pi will keep. It writes a handoff covering decisions, constraints, dead ends, and next steps. Modified paths are appended. On another compaction, the extension rebuilds the copied history rather than nesting it.
- **Data flow:** the selected provider receives conversation text and the local path to the session file. With a hosted model, these leave your machine. The stored brief also includes the path for retrieving omitted detail. This is not a redaction tool.

If the model fails, compaction is cancelled rather than silently switching prompts. Fix the cause and retry `/compact`; repeated failures can leave you with a full context. To use pi's default for one session, set `PI_COMPACTION_BRIEF=off` when starting pi. To uninstall:

```sh
pi remove git:github.com/pandysp/pi-compaction-brief@v0.1.0
```

## Tests and evidence

With Node 24 or newer and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
```

The offline tests use pi's compaction preparation and a fake provider; no login or model calls. [Fictional cases](test/fixtures/handoffs.json) pair conversations with facts a good brief should preserve. Tests check which text is copied and which reaches the model, **not** whether a generated brief satisfies the rubric. Dependencies for these tests are pinned to pi 1.5.2.

In a private comparison on 30 first compactions, two model judges ranked this approach first against two experimental alternatives on 30/30 and 25/30 cases respectively. They read summaries; they did not resume the tasks or compare this version with pi's default. The underlying conversations are not distributed. Background: [You don't need long context](https://arxiv.org/abs/2611.05306).

For a new prompt, run the released tag and the candidate on the same held-out cases with the same model and cut. Check must-preserve facts in the **model-written section**, then judge handoffs blind in both orders; allow ties and both-fail outcomes. Known regression fixtures aren't held-out evidence.

## License

[MIT](LICENSE). See [third-party notices](THIRD-PARTY-NOTICES).
