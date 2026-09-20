"""Error model (src/errors.ts port)."""

import re

from .spec import suggested_call_for

CORE_UNAVAILABLE_MESSAGE = "\n".join(
    [
        "DocsAgent Core is not running.",
        "",
        "Start it with:    docsagent start",
        "Check status:     docsagent status",
        "Core log:         see core.log next to the config file",
    ]
)

CORE_MAP = {
    "source_unknown": "source_not_found",
    "item_not_found": "no_content",
    "no_attachment": "no_content",
    "index_not_ready": "index_unavailable",
    "index_building": "index_building",
    "web_api_error": "web_api_error",
    "auth_failed": "auth_failed",
    "invalid_params": "invalid_params",
}


class DocsAgentError(Exception):
    def __init__(self, code: str, message: str, suggested_call: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.suggested_call = suggested_call


def _extract_id(message: str) -> str:
    m = re.search(r"[A-Z0-9]{8}", message)
    return m.group(0) if m else "unknown"


def core_error_to_docs_agent(err: dict) -> DocsAgentError:
    """Map a JSON-RPC error object from the core to a DocsAgentError."""
    data = err.get("data") or {}
    core_code = data.get("code") if isinstance(data, dict) else None
    if core_code and CORE_MAP.get(core_code):
        mapped = CORE_MAP[core_code]
        message = err.get("message") or core_code
        if core_code == "item_not_found":
            message = (data.get("message") if isinstance(data, dict) else None) or (
                f"Item not found: {_extract_id(message)}"
            )
        if core_code == "no_attachment":
            message = (data.get("message") if isinstance(data, dict) else None) or (
                "Item has no readable content"
            )
        return DocsAgentError(mapped, message, suggested_call_for(mapped))
    code = core_code or "core_error"
    return DocsAgentError(code, f"core error: {err.get('message') or 'unknown core error'}")


def error_body(err) -> dict:
    """The JSON body returned as an isError tool result."""
    if isinstance(err, DocsAgentError):
        body: dict = {"code": err.code, "message": err.message}
        if err.suggested_call:
            body["suggested_call"] = err.suggested_call
        return {"error": body}
    message = str(err)
    return {"error": {"code": "internal_error", "message": message}}


def is_connect_failure(err) -> bool:
    """Connection-level failures (refused / unreachable) -> core_unavailable."""
    if isinstance(err, DocsAgentError):
        return False
    import socket
    import urllib.error

    if isinstance(err, urllib.error.URLError):
        cause = err.reason
        if isinstance(cause, (ConnectionRefusedError, ConnectionResetError, socket.gaierror)):
            return True
        if isinstance(cause, OSError) and cause.errno in (-2, 61, 64, 65, 8):
            return True
    if isinstance(err, (ConnectionRefusedError, ConnectionResetError)):
        return True
    if isinstance(err, OSError) and err.errno in (8, -2, 61, 64, 65):
        return True
    return False
