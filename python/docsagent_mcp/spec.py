"""Spec-driven contract loading (src/spec.ts port).

The JSON files under ``docsagent_mcp/spec/`` are a synced copy of the repo
root's ``spec/`` (the single-sourced contract). Refresh them with
``python/sync_spec.py`` after editing the root spec.
"""

import json
import os
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
SPEC_DIR = Path(os.environ.get("DOCSAGENT_SPEC_DIR") or (PKG_DIR / "spec"))
TOOLS_DIR = SPEC_DIR / "tools"

_tool_specs: list[dict] | None = None
_errors_spec: dict | None = None
_config_spec: dict | None = None


def load_tool_specs() -> list[dict]:
    global _tool_specs
    if _tool_specs is None:
        specs = []
        for p in sorted(TOOLS_DIR.glob("*.json")):
            spec = json.loads(p.read_text(encoding="utf-8"))
            expected = p.stem
            if spec.get("name") != expected:
                raise ValueError(
                    f"spec/tools/{p.name}: name {spec.get('name')!r} does not match file name"
                )
            specs.append(spec)
        _tool_specs = specs
    return _tool_specs


def load_tool_spec(name: str) -> dict | None:
    for spec in load_tool_specs():
        if spec["name"] == name:
            return spec
    return None


def load_errors_spec() -> dict:
    global _errors_spec
    if _errors_spec is None:
        _errors_spec = json.loads((SPEC_DIR / "errors.json").read_text(encoding="utf-8"))
    return _errors_spec


def load_config_spec() -> dict:
    global _config_spec
    if _config_spec is None:
        _config_spec = json.loads((SPEC_DIR / "config.json").read_text(encoding="utf-8"))
    return _config_spec


def suggested_call_for(code: str) -> dict | None:
    entry = load_errors_spec().get("errors", {}).get(code)
    if not entry:
        return None
    return entry.get("suggested_call")
