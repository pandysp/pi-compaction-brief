# Compare two compaction briefs

Run from a clone (with Git tags, Node 24+, pnpm, and `tar`). Both refs must exist locally. Fetch a contributor's branch before selecting it. **Only evaluate trusted revisions**: the runner executes their TypeScript with your user permissions and passes model credentials to their summarizer. No sandbox is provided.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run eval --baseline v0.1.0 --candidate HEAD \
  --model openai-codex/gpt-6.2-sol --judge openai-codex/gpt-6.2-astra \
  --out /tmp/brief-report.json
```

Use any compatible model IDs configured in pi (the resume model must support tool calls, the judge must return structured JSON). Use your own login or provider API key. This calls the providers and consumes usage. No personal conversations are needed. Three bundled cases use **20 model calls** before provider retries: eight summaries, six simulated next-action calls and six judgments. The output path must not already exist. Keep runs with real data private: the report contains summaries and judge reasoning, and inputs are sent to the providers you select.

`--cases PATH` supplies your own JSON array instead of the [fictional fixtures](../test/fixtures/handoffs.json); `--reasoning LEVEL` changes the shared default of `low`. Each case declares older user messages, one recent retained message, a fact rubric and a finite menu of actions with an expected answer. A `next` step supplies a new cut: the previous recent message joins the summarized span, and each arm receives **its own** previous checkpoint. This is a controlled replay, not a token-threshold or tool-transcript simulator.

The runner extracts `src/` and `package.json` at each Git commit and uses the harness checkout’s pinned dependencies for both. Candidates must implement `summarize(preparation, options)` in `src/brief.ts` and return `summary` plus `written` (the model-authored portion alone). For v0.1.0 the harness extracts that portion from the legacy format. New candidates need no particular delimiter. The report records both commit IDs, harness commit, dataset hash, models, reasoning, checkpoints and rubric votes. Hosted model aliases and sampling can vary; reproducing the **procedure** need not reproduce every sentence or preference.

The judge sees the source and two anonymous **written sections**, plus the recent message both agents retain. Each rubric item is pass/fail. A factual failure overrides stylistic preference. Both can fail; equally useful summaries can tie. The runner reverses the labels and records disagreement as inconclusive. Separately, the resume model sees the **whole checkpoint plus recent message** and chooses an inert action. The exact choice is scored without a judge. This measures a constrained next decision, not success on a full software task.

Use known fixtures for development, then use fresh cases for a release decision. Do not pool factual failures, resume errors, and preferences into one win rate. See [methods from the original study](history.md).
