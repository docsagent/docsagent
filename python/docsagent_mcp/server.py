"""MCP server wiring (src/server.ts port) - mcp SDK 2.x registration API."""

import json

import mcp.types as types
from mcp.server.lowlevel import Server

from . import SERVER_NAME, SERVER_VERSION
from .context import ToolContext, error_output, validate_args
from .errors import DocsAgentError
from .spec import load_tool_specs
from .tools import ANNOTATIONS, HANDLERS, WRITE_TOOLS

INSTRUCTIONS = (
    "DocsAgent searches and reads a Zotero library through a resident search core. "
    "Use list_sources to discover sources, search with target=annotations for highlights, "
    "and get_content/get_metadata to drill into a result. Write tools require confirmed=true."
)


def allowed_tool_names(config: dict, role: str | None = None) -> set[str]:
    """Tool names this session/identity may see: registered set (write tools
    removed when enableWrites=false) intersected with the RBAC grant for the
    role, if any. A role with no rbacRoles entry has full access."""
    names = set(HANDLERS.keys())
    if not config["enableWrites"]:
        names -= WRITE_TOOLS
    grants = config["rbacRoles"].get(role) if role is not None else None
    if grants:
        granted = set(grants)
        names = {n for n in names if n in granted}
    return names


def create_tool_server(ctx: ToolContext, opts: dict | None = None) -> Server:
    """Low-level MCP server. Tool definitions come verbatim from
    spec/tools/*.json (spec/README.md consume rule 1) - no schema mirror."""
    opts = opts or {}
    role_provider = opts.get("role_provider") or (lambda: None)
    audit = opts.get("audit")
    config = ctx.config

    server = Server(SERVER_NAME, version=SERVER_VERSION, instructions=INSTRUCTIONS)

    async def _list_tools(_rc, _params) -> types.ListToolsResult:
        allowed = allowed_tool_names(config, role_provider())
        tools = []
        for spec in load_tool_specs():
            if spec["name"] not in allowed:
                continue
            ann = ANNOTATIONS.get(spec["name"])
            tools.append(
                types.Tool(
                    name=spec["name"],
                    title=spec.get("title"),
                    description=spec["description"],
                    inputSchema=spec["inputSchema"],
                    annotations=types.ToolAnnotations(**ann) if ann else None,
                )
            )
        return types.ListToolsResult(tools=tools)

    async def _call_tool(_rc, params: types.CallToolRequestParams) -> types.CallToolResult:
        name = params.name
        args = params.arguments or {}
        ok = True
        try:
            if name not in HANDLERS:
                raise DocsAgentError("invalid_params", f'Unknown tool "{name}"')
            if name in WRITE_TOOLS and not config["enableWrites"]:
                raise DocsAgentError(
                    "write_disabled",
                    "Write operations are disabled (enableWrites=false); the write tools are not registered",
                )
            if name not in allowed_tool_names(config, role_provider()):
                raise DocsAgentError("forbidden", f'Tool "{name}" is not permitted for this session')
            validated = validate_args(name, args)
            out = await HANDLERS[name](ctx, validated)
            if isinstance(out, types.CallToolResult):
                ok = bool(out.is_error)
                return out
            if isinstance(out, dict):
                ok = not out.get("isError", False)
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=json.dumps(out, ensure_ascii=False))],
                    is_error=not ok,
                )
            return types.CallToolResult(content=list(out))
        except Exception as err:
            ok = False
            ctx.logger.debug(f"tool {name} failed: {err}")
            return error_output(err)
        finally:
            if audit:
                audit(name, ok)

    server.add_request_handler("tools/list", types.PaginatedRequestParams, _list_tools)
    server.add_request_handler("tools/call", types.CallToolRequestParams, _call_tool)
    return server
