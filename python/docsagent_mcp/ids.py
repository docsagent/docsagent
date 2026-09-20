"""Global id helpers (src/ids.ts port)."""

from .errors import DocsAgentError


class GlobalId:
    __slots__ = ("source", "local_id")

    def __init__(self, source: str, local_id: str) -> None:
        self.source = source
        self.local_id = local_id


def parse_global_id(id_: str, default_source: str | None = None) -> GlobalId:
    if id_.startswith("zotero-group:"):
        rest = id_[len("zotero-group:"):]
        sep = rest.find(":")
        if 0 < sep < len(rest) - 1:
            return GlobalId(f"zotero-group:{rest[:sep]}", rest[sep + 1:])
    else:
        sep = id_.find(":")
        if 0 < sep < len(id_) - 1:
            return GlobalId(id_[:sep], id_[sep + 1:])
    if default_source and ":" not in id_ and len(id_) > 0:
        return GlobalId(default_source, id_)
    raise DocsAgentError(
        "invalid_params",
        f'Invalid global id "{id_}": expected "{{source}}:{{localId}}", e.g. "zotero:ABCD1234"',
    )


def format_global_id(source: str, local_id: str) -> str:
    return f"{source}:{local_id}"


def group_source_name(group_id) -> str:
    return f"zotero-group:{group_id}"
