"""Tool registry: names, write set, annotations, handlers."""

from .read import get_content_tool, get_metadata_tool, list_library_tool, list_sources_tool
from .search import search_tool
from .write import add_note_tool, batch_modify_tool, import_item_tool

HANDLERS = {
    "search": search_tool,
    "get_metadata": get_metadata_tool,
    "get_content": get_content_tool,
    "list_library": list_library_tool,
    "list_sources": list_sources_tool,
    "import_item": import_item_tool,
    "add_note": add_note_tool,
    "batch_modify": batch_modify_tool,
}

WRITE_TOOLS = {"import_item", "add_note", "batch_modify"}

ANNOTATIONS = {
    "search": {"readOnlyHint": True},
    "get_metadata": {"readOnlyHint": True},
    "get_content": {"readOnlyHint": True},
    "list_library": {"readOnlyHint": True},
    "list_sources": {"readOnlyHint": True},
    "import_item": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    "add_note": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False},
    "batch_modify": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": False},
}
