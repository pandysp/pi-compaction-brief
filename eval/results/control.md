# Same-behavior control, November 22, 2026

[Full run: both outputs, each cut, fact checks, and both judge orders](control.json). Compared `v0.1.0` (`8509362`) with `4077fa2` from a clean clone. The candidate exposes the model-written section separately; it does **not** change the compaction prompt or the stored brief. Each side generated its own text. This measures run-to-run variation, not a new algorithm's win rate.

Model and resume task: GPT-6.2 Sol. Judge: GPT-6.2 Astra. Reasoning: low. Three fictional cases; no real session inputs.

| Case | Baseline first / candidate first (votes decoded) | Combined | Next action |
|---|---|---|---|
| SQLite → Postgres | both fail / both fail | both fail | Both chose `show_plan:postgres` |
| Rejected backup | candidate / candidate | candidate | Both requested a replacement |
| CSV → TSV after an earlier compaction | tie / baseline | inconclusive | Both chose to prepare TSV and wait |

For Postgres, both orders marked the first fact missing from both **written briefs**: neither explicitly named Postgres as replacing SQLite. The pending migration and plan-before-edits facts passed. Both **whole checkpoints**, which also carry copied user instructions, supported the correct next action. This disagreement between measures matters: a missing fact in generated prose does not prove the agent lost it, and a successful choice from a short menu does not prove it would complete the migration.

Do not pick a new default from these results. To compare a real candidate, supply different trusted revisions and fresh cases; keep the generation settings, cut points and action menu the same across arms.
