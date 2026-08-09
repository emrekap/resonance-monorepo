"""Sweep the negative controls' false-positive rate across world seeds.

Diligence script, not part of the harness — that is why it sits at the top
level of `research/`, beside `eval/`, rather than inside it. `docs/
validation-prereg.md` §9 discloses how often each negative control fires on
CLEAN synthetic data (a "false positive": the control voids a run that was
never contaminated). That number has to come from somewhere reproducible, and
before this script existed it did not: two prior measurements of the same
disclosure disagreed, because the seed convention that decides the number was
never written down (see the fix-orders / final-review record for
2026-08-08-validation-eval-harness).

Every choice this script makes is explicit, here and in `--help`:

* **What varies.** The WORLD seed (`eval.synth.World.seed`), not the control
  seed passed to `label_shuffle_control`. The two are set to the SAME value —
  each sweep step draws one fresh synthetic world at seed `s` and evaluates
  the controls on it with `run_controls(..., seed=s)` — because that is the
  only design in which `brain_average_control` and `feature_label_leak_control`
  (neither of which takes a seed) can move at all: their only seed-sensitivity
  is through the data itself.
* **Which regime.** `eval.splits.regime1_temporal` — the same split
  `eval.cli.run` gates on (`gate_split`), because that is the regime with a
  per-creator history to shuffle within.
* **Which worlds.** Both `eval.synth.NULL_WORLD` and `eval.synth.SIGNAL_WORLD`,
  seed overridden per step; all other `World` fields (creator count, effect
  sizes, noise) are left as `synth.py` defines them.
* **The range.** `--start` / `--count`, defaulting to **0 and 30** — a window
  stated in advance and never chosen after seeing where a control fires. Do
  not change the defaults to make a number look better; if a window is needed
  for a specific claim, pass it explicitly and say so in prose.

Stdout only — no file is written, and nothing here needs a fixed golden value
to pin against, so it carries no test. It must stay deterministic (no
unseeded randomness) and it must not import torch (this package evaluates
predictions; it never runs a model).

Usage:

    ./.venv/bin/python sweep_controls.py                  # seeds 0..29, both worlds
    ./.venv/bin/python sweep_controls.py --start 0 --count 50
"""

from __future__ import annotations

import argparse
from dataclasses import replace

import numpy as np

from eval.controls import ControlResult, run_controls
from eval.snapshot import Snapshot
from eval.splits import regime1_temporal
from eval.synth import NULL_WORLD, SIGNAL_WORLD, World, generate

WORLDS: dict[str, World] = {"null": NULL_WORLD, "signal": SIGNAL_WORLD}

#: Fixed by `run_controls`' own definition — kept as a named constant here so
#: a future fourth control shows up in this sweep without a code change.
CONTROL_NAMES = ("label_shuffle", "brain_average", "feature_label_leak")


def _run_one(world: World, seed: int) -> dict[str, ControlResult]:
    """One sweep step: a fresh world at `seed`, controls run with the same seed.

    The world's OTHER fields (creator count, effect sizes, noise, ...) are
    exactly what `synth.py` commits to for `world.name` — only `seed` moves.
    """
    stepped = replace(world, seed=seed)
    posts, text, neuro = generate(stepped)
    snap = Snapshot(posts=posts, text=text, neuro=neuro, manifest={})
    split = regime1_temporal(snap.posts)
    return {r.name: r for r in run_controls(snap, split, seed=seed)}


def sweep(world: World, start: int, count: int) -> list[dict[str, ControlResult]]:
    """Run the sweep for one world; one dict of results per seed in the window."""
    return [_run_one(world, seed) for seed in range(start, start + count)]


def _summarize(name: str, rows: list[dict[str, ControlResult]]) -> tuple[int, int, float, int]:
    """(fires, total, sd-of-the-statistic, nan-count) for one control."""
    values = np.array([row[name].value for row in rows], dtype=float)
    fires = sum(1 for row in rows if not row[name].passed)
    # nanstd rather than std: an unmeasurable step (NaN value, e.g. a control
    # excluded every creator) must not silently poison the sd of every other
    # step by propagating NaN through the whole reduction.
    sd = float(np.nanstd(values)) if np.isfinite(values).any() else float("nan")
    nan_count = int(np.isnan(values).sum())
    return fires, len(rows), sd, nan_count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sweep_controls",
        description=(
            "Sweep the world seed over NULL_WORLD and SIGNAL_WORLD, run the three "
            "negative controls (eval.controls.run_controls) on each draw's "
            "regime1_temporal split, and report how often each control fires on "
            "data that was never contaminated — the false-positive rate quoted in "
            "docs/validation-prereg.md §9. The world seed and the seed passed to "
            "run_controls are always the same value, swept together."
        ),
    )
    parser.add_argument(
        "--start",
        type=int,
        default=0,
        help=(
            "First world seed in the sweep window. Default 0 — a window fixed in "
            "advance, not chosen after seeing where a control fires."
        ),
    )
    parser.add_argument(
        "--count",
        type=int,
        default=30,
        help="Number of consecutive seeds to sweep, starting at --start. Default 30.",
    )
    args = parser.parse_args(argv)

    print(
        f"sweeping seeds [{args.start}, {args.start + args.count}) over "
        f"{', '.join(WORLDS)} worlds, Regime 1 (regime1_temporal), "
        f"run_controls(..., seed=<world seed>)\n"
    )

    header = f"{'world':<8} {'control':<20} {'fires/total':<13} {'rate':<8} {'sd':<8} {'nan':<4}"
    print(header)
    print("-" * len(header))
    for world_name, world in WORLDS.items():
        rows = sweep(world, args.start, args.count)
        for control_name in CONTROL_NAMES:
            fires, total, sd, nan_count = _summarize(control_name, rows)
            rate = f"{fires / total:.1%}"
            sd_repr = f"{sd:.3f}" if np.isfinite(sd) else "n/a"
            print(
                f"{world_name:<8} {control_name:<20} {f'{fires}/{total}':<13} "
                f"{rate:<8} {sd_repr:<8} {nan_count:<4}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
