#!/usr/bin/env python
"""Post-install patcher for the vendored tribev2 / neuralset packages.

These packages assume a CUDA GPU in a couple of places that break on CPU / Apple
Silicon. This script re-applies small source patches that fix them. It is
idempotent — safe to run after every `pip install` / venv rebuild.

Patches:
  1. tribev2.eventstransforms — whisperx `compute_type` is hardcoded to
     "float16", which only works on CUDA. ctranslate2 raises on CPU:
       ValueError: Requested float16 compute type, but the target device or
       backend do not support efficient float16 computation.
     -> make it device-aware (int8 on non-CUDA).
  2. neuralset.extractors.base — the HuggingFace extractor `device` field is a
     Literal that omits "mps", so Apple-Silicon GPU acceleration can't be
     selected. -> add "mps" to the allowed values.

Usage:
    python postinstall.py
"""

import importlib
import sys
from pathlib import Path


class Patch:
    def __init__(self, module: str, original: str, patched: str, marker: str, desc: str):
        self.module = module
        self.original = original
        self.patched = patched
        self.marker = marker
        self.desc = desc

    def _path(self) -> Path:
        try:
            mod = importlib.import_module(self.module)
        except ImportError as exc:
            sys.exit(f"ERROR: cannot import {self.module} ({exc}). Is it installed?")
        path = Path(mod.__file__)
        if not path.is_file():
            sys.exit(f"ERROR: could not locate source for {self.module} at {path}.")
        return path

    def apply(self) -> None:
        path = self._path()
        text = path.read_text()
        if self.marker in text:
            print(f"OK: already patched ({self.desc}) -> {path}")
            return
        if self.original not in text:
            sys.exit(
                f"ERROR: expected code for '{self.desc}' not found; the package "
                f"version may have changed. Inspect and patch manually:\n  {path}"
            )
        path.write_text(text.replace(self.original, self.patched, 1))
        print(f"PATCHED: {self.desc} -> {path}")


PATCHES = [
    Patch(
        module="tribev2.eventstransforms",
        original=(
            '        device = "cuda" if torch.cuda.is_available() else "cpu"\n'
            '        compute_type = "float16"'
        ),
        patched=(
            '        device = "cuda" if torch.cuda.is_available() else "cpu"\n'
            "        # float16 is only efficient on CUDA GPUs; CPU/ctranslate2 needs int8 (or float32).\n"
            '        compute_type = "float16" if device == "cuda" else "int8"'
        ),
        marker='compute_type = "float16" if device == "cuda" else "int8"',
        desc="whisperx compute_type is device-aware",
    ),
    Patch(
        module="neuralset.extractors.base",
        original='    device: tp.Literal["auto", "cpu", "cuda", "accelerate"] = "auto"',
        patched='    device: tp.Literal["auto", "cpu", "cuda", "mps", "accelerate"] = "auto"',
        marker='tp.Literal["auto", "cpu", "cuda", "mps", "accelerate"]',
        desc="extractor device Literal allows 'mps'",
    ),
]


def main() -> None:
    for patch in PATCHES:
        patch.apply()


if __name__ == "__main__":
    main()
