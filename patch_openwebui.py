#!/usr/bin/env python3
"""Portable Open WebUI custom-nav patcher.

Usage:
  python3 patch_openwebui.py --dry-run [--verbose]
  python3 patch_openwebui.py --apply [--verbose]
  python3 patch_openwebui.py --restore [--verbose]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


MARKER_START = "<!-- CUSTOM_NAV_INJECTOR_START -->"
MARKER_END = "<!-- CUSTOM_NAV_INJECTOR_END -->"
BACKUP_SUFFIX = ".original.customnav.bak"
MANIFEST_NAME = ".customnav-manifest.json"

ASSET_FILES = ("nav-injector.js", "nav-injector.css", "nav-config.json")

COMMON_FRONTEND_DIRS = (
    "/app/backend/open_webui/frontend",
    "/app/frontend/build",
    "/app/build",
    "/app/backend/open_webui/build",
)


@dataclass
class PatchTargets:
    frontend_dir: Path
    shell_file: Path
    custom_dir: Path


class PatcherError(RuntimeError):
    """Expected operational error."""


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def print_info(msg: str) -> None:
    print(msg)


def print_verbose(msg: str, enabled: bool) -> None:
    if enabled:
        print(f"[verbose] {msg}")


def _resolve_candidates() -> list[Path]:
    candidates: list[Path] = []
    env_frontend = os.getenv("FRONTEND_BUILD_DIR")
    if env_frontend:
        candidates.append(Path(env_frontend).resolve())
    candidates.extend(Path(raw).resolve() for raw in COMMON_FRONTEND_DIRS)
    # Keep order while de-duplicating.
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            ordered.append(path)
    return ordered


def _fallback_shell_from_dir(frontend_dir: Path, verbose: bool) -> Path | None:
    direct = (
        frontend_dir / "app.html",
        frontend_dir / "index.htm",
        frontend_dir / "templates" / "index.html",
        frontend_dir / "public" / "index.html",
    )
    found_direct = [p for p in direct if p.exists() and p.is_file()]
    if len(found_direct) == 1:
        print_verbose(f"fallback shell selected (direct): {found_direct[0]}", verbose)
        return found_direct[0]
    if len(found_direct) > 1:
        print_verbose(
            f"ambiguous direct fallback shell candidates: {', '.join(str(p) for p in found_direct)}",
            verbose,
        )
        return None

    # Recursive fallback, constrained to reduce brittleness.
    discovered: list[Path] = []
    for file_path in frontend_dir.rglob("*.html"):
        rel = file_path.relative_to(frontend_dir).as_posix()
        if "/node_modules/" in f"/{rel}/":
            continue
        name = file_path.name.lower()
        if name not in ("app.html", "index.html", "index.htm"):
            continue
        depth = len(file_path.relative_to(frontend_dir).parts)
        if depth > 4:
            continue
        discovered.append(file_path)

    if len(discovered) == 1:
        print_verbose(f"fallback shell selected (recursive): {discovered[0]}", verbose)
        return discovered[0]
    if len(discovered) > 1:
        print_verbose(
            f"ambiguous recursive fallback shell candidates: {', '.join(str(p) for p in discovered)}",
            verbose,
        )
    return None


def discover_targets(verbose: bool) -> PatchTargets:
    candidates = _resolve_candidates()
    if not candidates:
        raise PatcherError("No frontend directory candidates available.")

    print_info("Checked frontend directory candidates:")
    for candidate in candidates:
        print_info(f"  - {candidate}")

    for frontend_dir in candidates:
        if not frontend_dir.exists() or not frontend_dir.is_dir():
            print_verbose(f"candidate is not a directory: {frontend_dir}", verbose)
            continue

        preferred_shell = frontend_dir / "index.html"
        if preferred_shell.exists() and preferred_shell.is_file():
            shell_file = preferred_shell
            print_verbose(f"preferred shell selected: {shell_file}", verbose)
        else:
            shell_file = _fallback_shell_from_dir(frontend_dir, verbose)
            if shell_file is None:
                print_verbose(
                    f"no stable shell template found for candidate: {frontend_dir}",
                    verbose,
                )
                continue

        custom_dir = frontend_dir / "custom"
        fallback_custom_dir = frontend_dir / "static" / "custom"
        if custom_dir.exists() and custom_dir.is_dir():
            chosen_custom = custom_dir
        elif fallback_custom_dir.exists() and fallback_custom_dir.is_dir():
            chosen_custom = fallback_custom_dir
        else:
            # Apply can create one of these; prefer /custom.
            chosen_custom = custom_dir

        return PatchTargets(frontend_dir=frontend_dir, shell_file=shell_file, custom_dir=chosen_custom)

    raise PatcherError(
        "Could not find a suitable Open WebUI frontend shell file. "
        "No patch was applied."
    )


def build_injection_block() -> str:
    return (
        f"{MARKER_START}\n"
        '<link rel="stylesheet" href="/custom/nav-injector.css">\n'
        '<script src="/custom/nav-injector.js"></script>\n'
        f"{MARKER_END}\n"
    )


def patch_shell_content(original: str) -> tuple[str, bool]:
    block = build_injection_block()
    marker_re = re.compile(
        re.escape(MARKER_START) + r".*?" + re.escape(MARKER_END) + r"\s*",
        flags=re.DOTALL,
    )

    if marker_re.search(original):
        updated = marker_re.sub(block, original, count=1)
        changed = updated != original
        return updated, changed

    insertion_targets = ("</head>", "</body>")
    for target in insertion_targets:
        idx = original.lower().find(target)
        if idx != -1:
            updated = original[:idx] + block + original[idx:]
            return updated, True

    raise PatcherError(
        "No stable HTML insertion point found in shell file "
        "(missing </head> and </body>)."
    )


def ensure_source_assets(script_dir: Path) -> list[Path]:
    missing: list[str] = []
    source_paths: list[Path] = []
    for filename in ASSET_FILES:
        path = script_dir / filename
        if not path.exists() or not path.is_file():
            missing.append(str(path))
        else:
            source_paths.append(path)
    if missing:
        joined = "\n".join(f"  - {item}" for item in missing)
        raise PatcherError(f"Missing required asset file(s):\n{joined}")
    return source_paths


def load_manifest(path: Path, verbose: bool) -> dict:
    if not path.exists():
        print_verbose(f"manifest not found: {path}", verbose)
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive fallback
        raise PatcherError(f"Failed to read manifest at {path}: {exc}") from exc


def save_manifest(path: Path, payload: dict, dry_run: bool) -> None:
    if dry_run:
        print_info(f"WOULD WRITE MANIFEST {path}")
        return
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print_info(f"WROTE MANIFEST {path}")


def copy_assets(
    source_assets: Iterable[Path],
    custom_dir: Path,
    dry_run: bool,
    verbose: bool,
) -> list[dict]:
    copied: list[dict] = []
    if dry_run:
        print_info(f"WOULD ENSURE DIRECTORY {custom_dir}")
    else:
        custom_dir.mkdir(parents=True, exist_ok=True)
        print_verbose(f"ensured custom asset directory exists: {custom_dir}", verbose)

    for src in source_assets:
        dest = custom_dir / src.name
        pre_exists = dest.exists()
        action_prefix = "WOULD COPY" if dry_run else "COPIED"
        if dry_run:
            print_info(f"{action_prefix} {src} -> {dest}")
            copied.append(
                {
                    "source": str(src),
                    "destination": str(dest),
                    "created_by_tool": not pre_exists,
                    "sha256": sha256_file(src),
                }
            )
            continue

        shutil.copy2(src, dest)
        print_info(f"{action_prefix} {src} -> {dest}")
        copied.append(
            {
                "source": str(src),
                "destination": str(dest),
                "created_by_tool": not pre_exists,
                "sha256": sha256_file(dest),
            }
        )
    return copied


def backup_file(path: Path, dry_run: bool) -> Path:
    backup_path = Path(str(path) + BACKUP_SUFFIX)
    if backup_path.exists():
        print_info(f"BACKUP EXISTS {backup_path}")
        return backup_path
    if dry_run:
        print_info(f"WOULD BACK UP {path} -> {backup_path}")
        return backup_path
    shutil.copy2(path, backup_path)
    print_info(f"BACKED UP {path} -> {backup_path}")
    return backup_path


def apply_patch(args: argparse.Namespace, script_dir: Path) -> int:
    targets = discover_targets(verbose=args.verbose)
    source_assets = ensure_source_assets(script_dir)
    manifest_path = script_dir / MANIFEST_NAME

    print_info(f"Selected frontend dir: {targets.frontend_dir}")
    print_info(f"Selected shell file: {targets.shell_file}")
    print_info(f"Selected custom dir: {targets.custom_dir}")

    shell_before = targets.shell_file.read_text(encoding="utf-8")
    shell_before_sha = sha256_text(shell_before)
    patched_content, changed = patch_shell_content(shell_before)
    if not changed:
        print_info("Shell already patched with current marker block; no content change needed.")

    copied_assets = copy_assets(
        source_assets=source_assets,
        custom_dir=targets.custom_dir,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )

    backup_path = backup_file(targets.shell_file, dry_run=args.dry_run)
    if args.dry_run:
        print_info(f"WOULD PATCH {targets.shell_file}")
    else:
        targets.shell_file.write_text(patched_content, encoding="utf-8")
        print_info(f"PATCHED {targets.shell_file}")

    shell_after_sha = sha256_file(targets.shell_file) if not args.dry_run else "dry-run"
    manifest = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "dry-run" if args.dry_run else "apply",
        "patched_files": [
            {
                "target": str(targets.shell_file),
                "backup": str(backup_path),
                "sha256_before": shell_before_sha,
                "sha256_after": shell_after_sha,
            }
        ],
        "assets": copied_assets,
        "marker_start": MARKER_START,
        "marker_end": MARKER_END,
    }
    save_manifest(manifest_path, manifest, dry_run=args.dry_run)
    return 0


def strip_marker_block(content: str) -> tuple[str, bool]:
    marker_re = re.compile(
        re.escape(MARKER_START) + r".*?" + re.escape(MARKER_END) + r"\s*",
        flags=re.DOTALL,
    )
    if not marker_re.search(content):
        return content, False
    return marker_re.sub("", content, count=1), True


def restore_from_manifest(manifest: dict, dry_run: bool) -> int:
    restored_any = False

    for entry in manifest.get("patched_files", []):
        target = Path(entry.get("target", ""))
        backup = Path(entry.get("backup", ""))
        if not target:
            continue
        if backup.exists():
            if dry_run:
                print_info(f"WOULD RESTORE {target} <- {backup}")
            else:
                shutil.copy2(backup, target)
                print_info(f"RESTORED {target} <- {backup}")
            restored_any = True
            continue

        if target.exists() and target.is_file():
            text = target.read_text(encoding="utf-8")
            stripped, removed = strip_marker_block(text)
            if removed:
                if dry_run:
                    print_info(f"WOULD REMOVE MARKER BLOCK FROM {target} (backup missing)")
                else:
                    target.write_text(stripped, encoding="utf-8")
                    print_info(f"REMOVED MARKER BLOCK FROM {target} (backup missing)")
                restored_any = True

    for asset in manifest.get("assets", []):
        if not asset.get("created_by_tool"):
            continue
        dest = Path(asset.get("destination", ""))
        if not dest.exists():
            continue
        if dry_run:
            print_info(f"WOULD REMOVE TOOL-CREATED ASSET {dest}")
        else:
            dest.unlink()
            print_info(f"REMOVED TOOL-CREATED ASSET {dest}")

    return 0 if restored_any else 2


def run_restore(args: argparse.Namespace, script_dir: Path) -> int:
    manifest_path = script_dir / MANIFEST_NAME
    manifest = load_manifest(manifest_path, verbose=args.verbose)

    if not manifest:
        print_info(
            "No manifest found. Cannot safely confirm patched targets for restore. "
            "Run --apply first or restore manually."
        )
        return 2

    result = restore_from_manifest(manifest, dry_run=args.dry_run)
    if result != 0:
        print_info("Restore did not confirm any patched target. Exiting with non-zero status.")
        return result
    print_info("Restore completed.")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Apply/restore Open WebUI custom navigation overlay patches."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Show what would be changed.")
    mode.add_argument("--apply", action="store_true", help="Apply patch and copy assets.")
    mode.add_argument("--restore", action="store_true", help="Restore files from backups.")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose diagnostics.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    script_dir = Path(__file__).resolve().parent

    if args.restore:
        return run_restore(args, script_dir)

    if args.apply:
        args.dry_run = False
    elif args.dry_run:
        args.apply = False

    return apply_patch(args, script_dir)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PatcherError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
