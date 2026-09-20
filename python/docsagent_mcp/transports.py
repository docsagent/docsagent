"""Streamable HTTP transport with origin checks, auth, per-request RBAC
(src/transports/http.ts port), and the /health liveness probe.

DESIGN.md section 3.3/6.2: MCP over Streamable HTTP on /mcp; GET /health for
liveness. RBAC (section 3.5) is enforced per request: the authenticator
resolves the caller's role and the tool gate consults it.
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from contextvars import ContextVar

from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from . import SERVER_NAME, SERVER_VERSION
from .errors import DocsAgentError
from .server import create_tool_server


async def serve_stdio(ctx, logger, role: str | None = None) -> None:
    """MCP over stdin/stdout (DESIGN.md section 3.3 local transport). All
    diagnostics go to stderr; stdout carries only the protocol."""
    from mcp.server.stdio import stdio_server

    server = create_tool_server(
        ctx,
        {
            # Local mode is the machine owner: no RBAC restriction beyond the
            # explicit --role override.
            "role_provider": (lambda: role) if role is not None else (lambda: None),
            "audit": lambda tool, ok: logger.debug(f"tool {tool} ok={ok}"),
        },
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
        logger.debug("stdio transport closed")

MAX_BODY_BYTES = 8 * 1024 * 1024
INTROSPECTION_CACHE_TTL_S = 60

# Per-request RBAC: the HTTP layer resolves the caller's role and the tool
# gate reads it (contextvar propagates into the SDK's request task).
_current_role: ContextVar[str | None] = ContextVar("docsagent_role", default=None)

# None = unrestricted (local role / role without an rbacRoles entry).
RoleKey = str | None


def _make_role_provider(fixed_role: str | None):
    """Role source for non-HTTP transports (a fixed --role)."""
    return lambda: fixed_role


def _parse_listen_addr(addr: str) -> tuple[str, int]:
    idx = addr.rfind(":")
    if idx <= 0 or idx == len(addr) - 1:
        raise DocsAgentError("invalid_params", f'Invalid httpListenAddr "{addr}"; expected "host:port"')
    host = addr[:idx]
    try:
        port = int(addr[idx + 1 :])
    except ValueError as err:
        raise DocsAgentError("invalid_params", f'Invalid port in httpListenAddr "{addr}"') from err
    if not 1 <= port <= 65535:
        raise DocsAgentError("invalid_params", f'Invalid port in httpListenAddr "{addr}"')
    return host, port


def _check_origin(config: dict, request) -> str | None:
    """DNS rebinding protection (DESIGN.md section 3.5): non-browser clients send
    no Origin; same-host and loopback origins are always accepted; others must be
    listed in authConfig.allowedOrigins."""
    origin = request.headers.get("origin")
    if not origin:
        return None
    from urllib.parse import urlparse

    try:
        parsed = urlparse(origin)
    except Exception:
        return f"Invalid Origin header: {origin}"
    host = request.headers.get("host")
    if host and parsed.netloc == host:
        return None
    allowed = (config.get("authConfig") or {}).get("allowedOrigins") or []
    if isinstance(allowed, list) and origin in allowed:
        return None
    if parsed.hostname in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"):
        return None
    return f'Origin "{origin}" is not allowed'


def _create_authenticator(config: dict, logger):
    """Port of createAuthenticator: none / api-key / oauth2 (RFC 7662)."""
    mode = config.get("authMode", "none")
    auth_config = config.get("authConfig") or {}

    if mode == "none":
        async def _authenticate(request):
            return None
        return _authenticate

    def _bearer(request) -> str:
        authorization = request.headers.get("authorization") or ""
        m = re.match(r"^Bearer\s+(\S+)$", authorization, re.IGNORECASE)
        if not m:
            what = "api-key" if mode == "api-key" else "access-token"
            raise DocsAgentError("unauthorized", f"Missing Authorization: Bearer <{what}> header")
        return m.group(1)

    if mode == "api-key":
        keys = auth_config.get("apiKeys") or {}
        if not isinstance(keys, dict) or not keys:
            logger.warn("authMode=api-key but authConfig.apiKeys is empty — every request will be rejected")

        async def _authenticate(request):
            token = _bearer(request)
            role = keys.get(token)
            if role is None and token not in keys:
                raise DocsAgentError("unauthorized", "Invalid API key")
            return role

        return _authenticate

    # authMode == "oauth2": RFC 7662 token introspection against the IdP.
    introspection_url = str(auth_config.get("introspectionUrl") or "")
    role_claim = str(auth_config.get("roleClaim") or "role")
    default_role = auth_config.get("defaultRole") if isinstance(auth_config.get("defaultRole"), str) else None
    cache: dict[str, tuple[str | None, float]] = {}

    async def _authenticate(request):
        if not introspection_url:
            raise DocsAgentError(
                "unauthorized",
                "authMode=oauth2 requires authConfig.introspectionUrl (RFC 7662 token introspection)",
            )
        token = _bearer(request)
        import time

        cached = cache.get(token)
        if cached and cached[1] > time.time():
            return cached[0]
        import urllib.parse

        body = urllib.parse.urlencode({"token": token})
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        client_id = auth_config.get("clientId")
        client_secret = auth_config.get("clientSecret")
        if isinstance(client_id, str) and isinstance(client_secret, str):
            import base64

            headers["Authorization"] = "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        import urllib.request

        req = urllib.request.Request(
            url=introspection_url, data=body.encode(), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                data = json.loads(res.read().decode("utf-8"))
        except DocsAgentError:
            raise
        except Exception as err:
            raise DocsAgentError("unauthorized", f"token introspection failed: {err}") from err
        if not data.get("active"):
            raise DocsAgentError("unauthorized", "Token is not active")
        role = data.get(role_claim) if isinstance(data.get(role_claim), str) else default_role
        cache[token] = (role, time.time() + INTROSPECTION_CACHE_TTL_S)
        return role

    return _authenticate


def serve_streamable_http(ctx, logger, role: str | None = None):
    """Sync: returns a configured uvicorn.Server; cli awaits .serve()."""
    import uvicorn

    config = ctx.config
    fixed_role = role

    def _effective_role(request_role: str | None) -> str | None:
        return fixed_role if fixed_role is not None else request_role

    server = create_tool_server(
        ctx,
        {
            "role_provider": lambda: _current_role.get(),
            "audit": lambda tool, ok: logger.info(
                f"[audit] role={_current_role.get() or 'unrestricted'} tool={tool} ok={ok}"
            ),
        },
    )
    # Stateful sessions, exactly like the JS shell: initialize -> Mcp-Session-Id.
    manager = StreamableHTTPSessionManager(app=server, json_response=True)
    authenticator = _create_authenticator(config, logger)
    host, port = _parse_listen_addr(config["httpListenAddr"])

    def _headers(scope) -> dict:
        return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}

    class _Req:
        def __init__(self, headers: dict) -> None:
            self.headers = headers

    async def _send_json(send, status: int, body) -> None:
        payload = json.dumps(body).encode("utf-8")
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": payload})

    async def _mcp_asgi(scope, receive, send) -> None:
        req = _Req(_headers(scope))
        origin_error = _check_origin(config, req)
        if origin_error:
            await _send_json(send, 403, {"error": {"code": "forbidden", "message": origin_error}})
            return
        try:
            request_role = await authenticator(req)
        except DocsAgentError as err:
            status = 403 if err.code == "forbidden" else 401
            await _send_json(send, status, {"error": {"code": err.code, "message": err.message}})
            return
        token = _current_role.set(_effective_role(request_role))
        try:
            await manager.handle_request(scope, receive, send)
        finally:
            _current_role.reset(token)

    async def _health(scope, receive, send) -> None:
        try:
            await asyncio.wait_for(asyncio.to_thread(ctx.core.call, "health", None, 1500), timeout=3)
            await _send_json(send, 200, {"status": "ok", "core": "ok", "version": SERVER_VERSION})
        except Exception:
            await _send_json(send, 503, {"status": "degraded", "core": "unavailable"})

    async def _dispatch(scope, receive, send) -> None:
        if scope["type"] != "http":
            raise RuntimeError("unsupported scope type")
        path = scope.get("path", "")
        if path == "/mcp":
            await _mcp_asgi(scope, receive, send)
            return
        if path == "/health" and scope.get("method") == "GET":
            await _health(scope, receive, send)
            return
        await _send_json(send, 404, {"error": {"code": "invalid_params", "message": f"Unknown endpoint {path}"}})

    @asynccontextmanager
    async def _lifespan(app):
        async with manager.run():
            logger.info(f"streamable-http listening on http://{host}:{port}/mcp (authMode={config.get('authMode')})")
            yield

    app = Starlette(routes=[Mount("/", app=_dispatch)], lifespan=_lifespan)
    logger.info(f"streamable-http listening on http://{host}:{port}/mcp (authMode={config.get('authMode')})")
    return uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
