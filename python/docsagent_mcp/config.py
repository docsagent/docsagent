"""Configuration loading (src/config.ts port)."""

import json
import os
import sys
from pathlib import Path

from .errors import DocsAgentError
from .spec import load_config_spec

DEFAULT_CONFIG = {
    "coreHost": "0.0.0.0",
    "httpPort": 23120,
    "coreBinary": "",
    "zoteroDataDir": "~/Zotero",
    "zoteroApiUrl": "http://localhost:23119/api",
    "zoteroGroups": [],
    "indexCheckInterval": 300,
    "groupSyncInterval": 3600,
    "enableWrites": False,
    "writeRateLimitPerHour": 30,
    "defaultSource": "zotero",
    "maxTokensPerTool": 4000,
    "logLevel": "info",
    "transport": "stdio",
    "httpListenAddr": "0.0.0.0:8080",
    "authMode": "none",
    "authConfig": {},
    "rbacRoles": {},
}

TYPE_CHECKS = {
    "coreHost": lambda v: isinstance(v, str),
    "httpPort": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "coreBinary": lambda v: isinstance(v, str),
    "zoteroDataDir": lambda v: isinstance(v, str),
    "zoteroApiUrl": lambda v: isinstance(v, str),
    "zoteroGroups": lambda v: isinstance(v, list),
    "indexCheckInterval": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "groupSyncInterval": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "enableWrites": lambda v: isinstance(v, bool),
    "writeRateLimitPerHour": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "defaultSource": lambda v: isinstance(v, str),
    "maxTokensPerTool": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "logLevel": lambda v: v in ("debug", "info", "warn", "error"),
    "transport": lambda v: v in ("stdio", "streamable-http"),
    "httpListenAddr": lambda v: isinstance(v, str),
    "authMode": lambda v: v in ("none", "api-key", "oauth2"),
    "authConfig": lambda v: isinstance(v, dict),
    "rbacRoles": lambda v: isinstance(v, dict),
}


def expand_home(p: str) -> str:
    return os.path.expanduser(p)


def config_path() -> Path:
    env = os.environ.get("DOCSAGENT_CONFIG")
    if env:
        return Path(expand_home(env))
    return Path.home() / ".docsagent" / "config.json"


def merge_config(file_value) -> dict:
    merged = dict(DEFAULT_CONFIG)
    merged["zoteroGroups"] = []
    merged["authConfig"] = {}
    merged["rbacRoles"] = {}
    if not isinstance(file_value, dict):
        return merged
    for key in DEFAULT_CONFIG:
        if key not in file_value:
            continue
        check = TYPE_CHECKS.get(key)
        if check and not check(file_value[key]):
            continue
        merged[key] = file_value[key]
    return merged


def validate_config_file(file_value) -> list[str]:
    """Validate the user config against spec/config.json (jsonschema)."""
    try:
        import jsonschema
    except ImportError:  # pragma: no cover - jsonschema is a declared dependency
        return []
    validator = jsonschema.Draft202012Validator(load_config_spec())
    return [f"{e.json_path}: {e.message}" for e in sorted(validator.iter_errors(file_value), key=str)]


def load_config() -> dict:
    file = config_path()
    file_value: object = {}
    if os.path.exists(file):
        try:
            with open(file, encoding="utf-8") as f:
                file_value = json.load(f)
        except json.JSONDecodeError as err:
            raise DocsAgentError(
                "invalid_params", f"Config file {file} is not valid JSON: {err}"
            ) from err
        problems = validate_config_file(file_value)
        if problems:
            sys.stderr.write(
                f"[docsagent] config warnings for {file}:\n"
                + "\n".join(f"  - {p}" for p in problems)
                + "\n"
            )
    return merge_config(file_value)


def docsagent_state_dir() -> str:
    return str(Path.home() / ".docsagent")
