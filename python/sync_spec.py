#!/usr/bin/env python3
"""Sync the package's bundled assets from the repo root (run from the repo root):
  - spec/ -> docsagent_mcp/spec/  (contract: tools, errors, config)
  - bin/  -> docsagent_mcp/bin/   (core binaries + dylibs, all platforms)
"""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = Path(__file__).resolve().parent / "docsagent_mcp"


def sync_spec() -> None:
    src, dst = ROOT / "spec", PKG / "spec"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    shutil.copy2(src / "errors.json", dst / "errors.json")
    shutil.copy2(src / "config.json", dst / "config.json")
    tools = dst / "tools"
    tools.mkdir()
    for f in sorted((src / "tools").glob("*.json")):
        shutil.copy2(f, tools / f.name)
    print(f"synced {src} -> {dst}")


def sync_bin() -> None:
    src, dst = ROOT / "bin", PKG / "bin"
    if not src.exists():
        print(f"WARNING: {src} not found - skipping bin sync (core lifecycle disabled)")
        return
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    total = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
    print(f"synced {src} -> {dst} ({total} bytes)")


if __name__ == "__main__":
    sync_spec()
    sync_bin()
