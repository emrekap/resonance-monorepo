#!/usr/bin/env python
"""Provision and manage the TRIBE v2 API Hugging Face Space from the CLI.

Replaces the click-through-the-settings-UI steps with idempotent API calls
(huggingface_hub >= 1.x). Reads your HF token from the environment / .env — the
same HF_TOKEN / HUGGING_FACE_HUB_TOKEN / HUGGINGFACE_TOKEN aliases main.py uses.

Commands:
    provision   Create the Space (if missing), set hardware + persistent storage,
                push the TRIBE_CACHE_DIR/HF_HOME variables and HF_TOKEN secret,
                enable Dev Mode, then upload the code (triggers the first build).
    deploy      Re-upload the local code to the Space (sync a code change).
    status      Print the Space runtime (stage, hardware, storage, dev mode).
    pause       Pause the Space to stop hourly GPU billing.
    restart     Restart the Space.

Examples:
    python manage_space.py provision                 # full first-time setup
    python manage_space.py provision --public        # anyone can call the URL
    python manage_space.py deploy                     # after editing code
    python manage_space.py pause                       # stop the meter
"""

import argparse
import os
import sys
from pathlib import Path

from huggingface_hub import HfApi, SpaceHardware, SpaceStorage

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_NAME = "tribev2-api"

# Cache the ~10 GB of weights on the persistent /data volume so they survive
# rebuilds/restarts (matches the Dockerfile override comment).
SPACE_VARIABLES = {
    "TRIBE_CACHE_DIR": "/data/cache",
    "HF_HOME": "/data/hf",
}

# Never upload local state or secrets to the Space repo. upload_folder does NOT
# honour .gitignore, so these are enforced here explicitly — .env in particular
# holds the real token and must never be pushed.
UPLOAD_IGNORE = [
    ".venv/*", "venv/*", "cache/*", "__pycache__/*", "*.pyc",
    "*.egg-info/*", ".env", ".git/*", ".DS_Store", ".idea/*", ".vscode/*",
]


def _resolve_token() -> str:
    """Load .env and return the HF token, matching main.py's alias handling."""
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO_ROOT / ".env")
    except ImportError:
        pass
    token = (
        os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HUGGINGFACE_TOKEN")
    )
    if not token or token == "hf_YOUR_TOKEN_HERE":
        sys.exit(
            "ERROR: no HuggingFace token found. Set HF_TOKEN in .env (a read "
            "token from https://huggingface.co/settings/tokens) and confirm your "
            "account has access to meta-llama/Llama-3.2-3B."
        )
    return token


def _repo_id(api: HfApi, token: str, name: str) -> str:
    """Build '<username>/<name>' from whoami (or accept a pre-qualified name)."""
    if "/" in name:
        return name
    who = api.whoami(token=token)
    return f"{who['name']}/{name}"


def _step(label: str, fn) -> None:
    """Run one provisioning step, reporting success/failure without aborting."""
    try:
        fn()
        print(f"  [ok]   {label}")
    except Exception as exc:  # noqa: BLE001 — report and continue
        print(f"  [warn] {label}: {exc}")


def provision(api: HfApi, token: str, args) -> None:
    repo_id = _repo_id(api, token, args.name)
    hardware = SpaceHardware(args.hardware)
    print(f"Provisioning Space '{repo_id}' (Docker SDK, hardware={hardware.value})…")

    url = api.create_repo(
        repo_id=repo_id,
        repo_type="space",
        space_sdk="docker",
        private=not args.public,
        exist_ok=True,
    )
    print(f"  [ok]   repo ready: {url}")

    _step(f"hardware -> {hardware.value}",
          lambda: api.request_space_hardware(repo_id, hardware, token=token))
    _step(f"storage -> {SpaceStorage.LARGE.value}",
          lambda: api.request_space_storage(repo_id, SpaceStorage.LARGE, token=token))
    for key, value in SPACE_VARIABLES.items():
        _step(f"variable {key}={value}",
              lambda k=key, v=value: api.add_space_variable(repo_id, k, v, token=token))
    _step("secret HF_TOKEN (from .env)",
          lambda: api.add_space_secret(repo_id, "HF_TOKEN", token, token=token))

    if args.dev_mode:
        _step("enable Dev Mode (requires HF PRO)",
              lambda: api.enable_space_dev_mode(repo_id, token=token))

    print("Uploading code (this triggers the first build)…")
    _step("upload folder",
          lambda: api.upload_folder(
              repo_id=repo_id, repo_type="space", folder_path=str(REPO_ROOT),
              ignore_patterns=UPLOAD_IGNORE, token=token,
              commit_message="Provision TRIBE v2 API Space"))

    print(f"\nDone. Watch the build at: https://huggingface.co/spaces/{repo_id}")
    print(f"Public URL once running: https://{repo_id.replace('/', '-')}.hf.space")
    if not args.public:
        print("Space is PRIVATE — call it with an auth header, e.g.:\n"
              "  curl -H \"Authorization: Bearer $HF_TOKEN\" "
              f"https://{repo_id.replace('/', '-')}.hf.space/health")


def deploy(api: HfApi, token: str, args) -> None:
    repo_id = _repo_id(api, token, args.name)
    print(f"Uploading local code to '{repo_id}'…")
    info = api.upload_folder(
        repo_id=repo_id, repo_type="space", folder_path=str(REPO_ROOT),
        ignore_patterns=UPLOAD_IGNORE, token=token,
        commit_message="Deploy code update",
    )
    print(f"  [ok]   {info.commit_url if hasattr(info, 'commit_url') else 'uploaded'}")


def status(api: HfApi, token: str, args) -> None:
    repo_id = _repo_id(api, token, args.name)
    rt = api.get_space_runtime(repo_id, token=token)
    print(f"Space:    {repo_id}")
    print(f"Stage:    {rt.stage}")
    print(f"Hardware: {rt.hardware}  (requested: {rt.requested_hardware})")
    print(f"Storage:  {getattr(rt, 'storage', None)}")
    print(f"URL:      https://{repo_id.replace('/', '-')}.hf.space")


def pause(api: HfApi, token: str, args) -> None:
    repo_id = _repo_id(api, token, args.name)
    api.pause_space(repo_id, token=token)
    print(f"Paused '{repo_id}'. GPU billing stops until you restart it.")


def restart(api: HfApi, token: str, args) -> None:
    repo_id = _repo_id(api, token, args.name)
    api.restart_space(repo_id, token=token)
    print(f"Restarting '{repo_id}'…")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", default=DEFAULT_NAME,
                        help=f"Space name or full owner/name (default: {DEFAULT_NAME})")
    sub = parser.add_subparsers(dest="command", required=True)

    p_prov = sub.add_parser("provision", help="create + configure + upload the Space")
    p_prov.add_argument("--hardware", default=SpaceHardware.L4X1.value,
                        choices=[h.value for h in SpaceHardware],
                        help="GPU flavor (default: l4x1)")
    p_prov.add_argument("--public", action="store_true",
                        help="make the Space public (default: private)")
    p_prov.add_argument("--no-dev-mode", dest="dev_mode", action="store_false",
                        help="skip enabling Dev Mode (which requires HF PRO)")
    p_prov.set_defaults(func=provision, dev_mode=True)

    sub.add_parser("deploy", help="re-upload local code").set_defaults(func=deploy)
    sub.add_parser("status", help="show runtime status").set_defaults(func=status)
    sub.add_parser("pause", help="pause the Space (stop billing)").set_defaults(func=pause)
    sub.add_parser("restart", help="restart the Space").set_defaults(func=restart)

    args = parser.parse_args()
    token = _resolve_token()
    api = HfApi(token=token)
    args.func(api, token, args)


if __name__ == "__main__":
    main()
