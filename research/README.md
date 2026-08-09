# research/

The eval harness for the pre-registered validation experiment. **Nothing here deploys** — that is
why it sits beside `apps/` rather than inside it.

Design: [`docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md`](../docs/superpowers/specs/2026-08-08-validation-eval-harness-design.md)
Commitment: [`docs/validation-prereg.md`](../docs/validation-prereg.md)

## Why it exists before the data does

The pre-registration locks one metric, one label, one baseline and a Δρ ≥ 0.10 bar. That is prose,
and prose does not enforce itself. This package turns each of its leakage rules into an assertion,
runs the negative controls as a gate rather than a footnote, and computes the Green/Yellow/Red band
mechanically so nobody picks it after seeing the numbers.

Writing it now is also the only chance to test the statistics against a known answer. With real data
nobody knows the right result, so a harness that computes the wrong Spearman looks exactly like one
that computes the right one.

## Run it

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m pytest

./.venv/bin/python -m eval synth --world signal --out ./snapshots/signal
./.venv/bin/python -m eval run --snapshot ./snapshots/signal --out ./out/signal
```

`--world` is one of `signal` (must return GREEN), `null` (must return RED) or `contaminated` (must
VOID the run). `run` writes `results.json` and `report.md` into `--out`.

### Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | A valid experiment ran. **GREEN, YELLOW and RED all exit 0** — RED is a result, not an error |
| `2`  | **VOID** — a negative control failed, so the experiment itself was invalid                   |

VOID is separated from the bands deliberately. A CI job or shell script that only reads the exit
status must not read an invalid run as a success; that is the fail-open shape this harness exists to
catch, so it is not allowed in the harness's own front door.

## The pipeline, and the one ordering that matters

```text
load -> split -> assemble features
     -> CONTROLS  -- fail --> VOID, stop, emit nothing further
     -> fit/predict ladder -> metrics -> stats -> verdict -> report
```

Controls run **before** the ladder because prereg §7 requires them to run before the primary result
is read. Ordering them later would mean computing the number first and deciding afterwards whether
we were allowed to look at it. On failure `run()` returns a payload with `regimes == {}`: not a
suppressed result, an uncomputed one.

Two things the pre-registration leaves open are decided in `cli.py`, in code, before any data exists:

- **The headline regime.** §7 says "Splits, both reported" and §8's results table has one unqualified
  "Verdict" row — it never says which regime that verdict is. The harness commits to **Regime 1**
  (new post, known creator), the production case, and the report **names** the regime the band came
  from with both regimes' own bands beside it, so a Regime-1 Green can never read as a joint result
  while Regime 2 is Red.
- **The baseline under NaN.** §5 fixes the baseline as `max(B1, B2)`. A plain `max` over a NaN is
  decided by argument order, so an unmeasurable rung would be named "the baseline to beat" and the
  uplift computed against it — inflating it exactly when the evidence is weakest. The baseline is
  chosen among **finite** rhos only; if neither is finite the uplift is NaN, which bands RED.

## The snapshot format is the contract

```text
snapshot/
  posts.parquet            post_id, creator_id, published_at, label, view_count, format,
                           duration_sec, hashtag_count, published_hour, published_dow,
                           follower_count
  features/b2_text.npy     [rows x dims], row-aligned to posts.parquet
  features/b3_neuro.npy    [rows x dims], row-aligned to posts.parquet
  manifest.json            version, producer, seed, rows, creators, dims, checksums
```

`label` is **`averageViewPercentage`** — the single primary label. `view_count` exists only to apply
the inclusion threshold and is never a feature.

## Testing — four worlds

| World            | Lives in                   | Harness must                           |
| ---------------- | -------------------------- | -------------------------------------- |
| **Signal**       | `synth.SIGNAL_WORLD`       | return GREEN                           |
| **Null**         | `synth.NULL_WORLD`         | return RED                             |
| **Contaminated** | `synth.CONTAMINATED_WORLD` | catch it in a control and VOID the run |
| **Leaky**        | `tests/test_end_to_end.py` | fire the matching leakage assertion    |

Three of those are properties of the **data**, so `synth.py` builds them. Leaky is a property of the
**split**, so there is no `LEAKY_WORLD`: the corrupt splits are built by hand in the tests and fed to
the pipeline. By hand, because `regime1_temporal` / `regime2_grouped` correctly refuse to emit a
corrupt split; and through the pipeline rather than by calling the assertion directly, because the
assertions' own unit tests cannot see whether the pipeline still calls them.

Which control catches the contaminated world is worth knowing, because it is not the one the prereg's
prose names: `label_shuffle` **passes** there by construction (permuting the label destroys the
feature↔label association as thoroughly as it destroys the model's ability to exploit it, so the
shuffled run lands at chance either way). `feature_label_leak` is what fires — it reads
max |ρ(feature, label)| over train rows before any model is fit.

## The deferred Postgres extract

Only the synthetic producer exists today. The extract is deliberately not written: the research
tables have never held a row, so anything written against them now is guesswork that gets rewritten
once real backfill exists. When it is written, it becomes a second producer of the format above —
the harness does not change.

Sketch, for whoever writes it:

- `posts.parquet` ← `posts` joined to `post_metric_snapshots` (latest per post) and `channels` for
  `follower_count`; `label` ← `post_labels.raw_value` where `kind = 'COMPLETION_RATE'`.
- `features/b3_neuro.npy` ← `feature_artifacts` rows for the post, fetched from object storage by
  `storage_bucket`/`storage_path` and verified against `checksum`.
- Inclusion (view threshold, ≥ 20 posts per creator) is applied in the extract, so a snapshot is
  always already eligible.
- `post_labels.split_tag` exists so the train/test rule is checkable in SQL. Once both exist,
  reconcile this package's splits against it rather than letting them disagree silently.

## Conventions

- **No torch.** This package evaluates predictions; it never runs a model.
- **Everything is seeded.** A run must be reproducible from its manifest.
- **Red-first precedence** in `verdict.py` is a commitment, not a style choice. Do not reorder it.
- **A voided run exits non-zero.** Do not "simplify" `main` to always return 0.
- **False-positive rates are measured, not assumed.** `sweep_controls.py` reproduces the negative-
  control disclosure in `docs/validation-prereg.md` §9; if that disclosure is ever revisited, regenerate
  it from the script rather than hand-editing the numbers.
