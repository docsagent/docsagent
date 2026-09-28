"""Tool context, argument validation, and the shared write gate (src/mcp/context.ts)."""

from dataclasses import dataclass, field

import json

import jsonschema
from mcp.types import CallToolResult, TextContent

from . import ids
from .core import CoreClient
from .errors import DocsAgentError, error_body
from .logger import Logger
from .ratelimit import RateLimiter
from .spec import load_tool_spec
from .zotero import ZoteroLocalApi

jsonschema.Draft202012Validator  # noqa: B018 (assert availability)


@dataclass
class ToolContext:
    config: dict
    core: CoreClient
    zotero: ZoteroLocalApi
    rate_limiter: RateLimiter
    logger: Logger
    sources: list = field(default_factory=list)
    group_syncer: object | None = None


def text_output(result) -> list:
    """A successful tool result: the JSON payload as text content."""
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


def error_output(err) -> CallToolResult:
    """An isError tool result carrying the docsagent error body."""
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(error_body(err), ensure_ascii=False))],
        isError=True,
    )


def validate_args(tool_name: str, args) -> dict:
    """Validate tool arguments against spec/tools/<name>.json (Ajv in the JS port)."""
    data = dict(args or {})
    spec = load_tool_spec(tool_name)
    if not spec:
        raise DocsAgentError("invalid_params", f'Unknown tool "{tool_name}"')
    validator = jsonschema.Draft202012Validator(spec["inputSchema"])
    errors = sorted(validator.iter_errors(data), key=str)
    if errors:
        msg = "; ".join(f"{'(root)' if not e.json_path else e.json_path}: {e.message}" for e in errors)
        if tool_name == "import_item":
            raise DocsAgentError(
                "missing_input", "import_item requires exactly one of paths or identifiers"
            )
        raise DocsAgentError("invalid_params", f"Invalid arguments for {tool_name} — {msg}")
    return data


def get_source_info(ctx: ToolContext, source: str) -> dict:
    for info in ctx.sources:
        if info.get("name") == source:
            return info
    raise DocsAgentError(
        "source_not_found", f'Unknown source "{source}"', {"tool": "list_sources", "args": {}}
    )


def resolve_id(ctx: ToolContext, raw_id, param: str = "id") -> ids.GlobalId:
    """Resolve + validate a global id against known sources."""
    if not isinstance(raw_id, str):
        raise DocsAgentError("invalid_params", f'Parameter "{param}" must be a string')
    gid = ids.parse_global_id(raw_id, ctx.config["defaultSource"])
    get_source_info(ctx, gid.source)
    return gid


def require_target(source: dict, target: str) -> None:
    if target not in source.get("targets", []):
        supported = ", ".join(source.get("targets", []))
        raise DocsAgentError(
            "target_not_supported",
            f'Source "{source["name"]}" does not support target "{target}" (supported: {supported})',
            {"note": f"Retry with one of: {supported}"},
        )


def require_capability(source: dict, capability: str) -> None:
    caps = source.get("capabilities") or []
    if capability not in caps:
        declared = ", ".join(caps) if caps else "none"
        raise DocsAgentError(
            "capability_not_supported",
            f'Source "{source["name"]}" does not declare the "{capability}" capability (declares: {declared})',
        )


def require_include(source: dict, include: str) -> None:
    includes = source.get("includes") or []
    if includes and include not in includes:
        supported = ", ".join(includes)
        raise DocsAgentError(
            "include_not_supported",
            f'Source "{source["name"]}" does not support include "{include}" (supported: {supported})',
            {"note": f"Supported includes: {supported}"},
        )


def write_gate(ctx: ToolContext, confirmed) -> bool:
    """Shared write gate (spec/algorithms/write-gate.md): enableWrites defense ->
    rate limit (confirmed writes only; previews consume no quota) -> confirm gate."""
    if not ctx.config["enableWrites"]:
        raise DocsAgentError(
            "write_disabled", "Write operations are disabled (enableWrites=false)"
        )
    is_confirmed = confirmed is True
    if is_confirmed:
        wait_s = ctx.rate_limiter.try_consume()
        if wait_s is not None:
            reset_min = max(1, (wait_s + 59) // 60)
            raise DocsAgentError(
                "rate_limited",
                f"Write rate limit exceeded ({ctx.config['writeRateLimitPerHour']}/h). Resets in ~{reset_min} min",
            )
    return is_confirmed
