"""Entry point: load config, bootstrap services, start the transport."""

import asyncio
import sys

from . import SERVER_NAME, SERVER_VERSION
from .config import docsagent_state_dir, load_config
from .context import ToolContext
from .core import CoreClient
from .logger import Logger
from .ratelimit import RateLimiter
from .server import allowed_tool_names
from .sync import GroupSyncer
from .transports import serve_streamable_http, serve_stdio
from .web import ZoteroWebApi
from .zotero import ZoteroLocalApi


async def bootstrap_services(config: dict, logger: Logger) -> ToolContext:
    """Startup flow: connect core (health, never spawn) -> load sources ->
    check index status. Connection failure propagates as core_unavailable."""
    core = CoreClient(config)
    health = await asyncio.to_thread(core.health)
    logger.info(f"core {health.get('version')} reachable via {core.describe_endpoint()}")

    sources = (await asyncio.to_thread(core.list_sources)).get("sources", [])
    logger.debug("sources: " + (", ".join(s.get("name", "") for s in sources) or "(none)"))

    try:
        st = await asyncio.to_thread(core.index_status, config["defaultSource"])
        if st.get("status") == "missing":
            logger.warn(f'index for "{st.get("source")}" is not built yet — run: docsagent-core rebuild-index')
        elif st.get("status") == "building":
            logger.info('index for the default source is building; search results may be partial')
    except Exception as err:
        logger.warn(f"indexStatus failed (continuing): {err}")

    group_sync_entries = build_group_syncers(config, core, logger)

    return ToolContext(
        config=config,
        core=core,
        zotero=ZoteroLocalApi(config["zoteroApiUrl"]),
        rate_limiter=RateLimiter(config["writeRateLimitPerHour"]),
        logger=logger,
        sources=sources,
        group_syncer=group_sync_entries[0]["syncer"] if group_sync_entries else None,
    )


def build_group_syncers(config: dict, core: CoreClient, logger: Logger) -> list[dict]:
    state_dir = docsagent_state_dir()
    return [
        {
            "group": group,
            "syncer": GroupSyncer(
                core,
                ZoteroWebApi(group["apiKey"]),
                config["zoteroDataDir"],
                f"{state_dir}/cache",
                f"{state_dir}/sync-state.json",
                logger,
            ),
        }
        for group in config["zoteroGroups"]
    ]


async def schedule_group_sync(entries: list[dict], config: dict, logger: Logger) -> None:
    """Startup sync + periodic re-sync (src/server.ts scheduleGroupSync)."""
    if not entries:
        return

    async def sync_all(trigger: str) -> None:
        for entry in entries:
            result = await asyncio.to_thread(entry["syncer"].sync_group, entry["group"])
            if result.get("mode") != "skipped":
                logger.info(
                    f"group sync {entry['group']['groupId']} ({trigger}, {result.get('mode')}): "
                    f"{result.get('indexed') or 0} items"
                )

    await sync_all("startup")
    while True:
        await asyncio.sleep(config["groupSyncInterval"])
        await sync_all("scheduled")


async def run_shell(transport: str | None = None, log_level: str | None = None, role: str | None = None) -> None:
    config = load_config()
    logger = Logger(config["logLevel"])
    if log_level:
        logger.set_level(log_level)
    transport = transport or config["transport"]
    allowed = allowed_tool_names(config, role)
    logger.debug(
        f"starting {SERVER_NAME} v{SERVER_VERSION} ({transport}); tools: {', '.join(sorted(allowed))}"
    )

    ctx = await bootstrap_services(config, logger)

    entries = build_group_syncers(config, ctx.core, logger)
    ctx.group_syncer = entries[0]["syncer"] if entries else None
    if entries:
        asyncio.create_task(schedule_group_sync(entries, config, logger))

    if transport == "streamable-http":
        http_server = serve_streamable_http(ctx, logger, role)
        await http_server.serve()
    else:
        await serve_stdio(ctx, logger, role)


def core_command(argv: list[str]) -> None:
    """Core lifecycle commands (src/core-service.ts): docsagent-mcp-zotero core start|stop|restart|status."""
    import argparse

    from . import core_service
    from .config import load_config

    parser = argparse.ArgumentParser(
        prog="docsagent-mcp-zotero core",
        description="Manage the resident DocsAgent Core background process.",
    )
    parser.add_argument("action", choices=["start", "stop", "restart", "status"])
    args = parser.parse_args(argv)
    config = load_config()

    if args.action == "start":
        r = core_service.start_core(config)
        state = "started" if r["started"] else "already running"
        print(f"DocsAgent Core {state} (pid {r['pid']}, endpoint {r['endpoint']}).")
        return
    if args.action == "stop":
        r = core_service.stop_core(config)
        print(
            f"DocsAgent Core stopped (pid {r['pid']})."
            if r["stopped"]
            else "DocsAgent Core not running."
        )
        return
    if args.action == "restart":
        r = core_service.restart_core(config)
        print(f"DocsAgent Core restarted (pid {r['pid']}, endpoint {r['endpoint']}).")
        return
    s = core_service.core_status(config)
    if s["reachable"]:
        print(
            f"DocsAgent Core running (pid {s['pid']}, reachable at {s['endpoint']}, version {s['version']})."
        )
    else:
        print("DocsAgent Core stopped.")
        raise SystemExit(1)


def main() -> None:
    import argparse

    argv = sys.argv[1:]
    if argv and argv[0] == "core":
        return core_command(argv[1:])

    parser = argparse.ArgumentParser(
        prog="docsagent-mcp-zotero",
        description="DocsAgent MCP shell for Zotero (Python). Talks to a resident C++ search core over HTTP.",
    )
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default=None)
    parser.add_argument("--log-level", choices=["debug", "info", "warn", "error"], default=None)
    parser.add_argument("--role", default=None, help="RBAC role (config.rbacRoles); default: unrestricted")
    parser.add_argument("--version", action="version", version=f"{SERVER_NAME} {SERVER_VERSION}")
    args = parser.parse_args(argv)
    try:
        asyncio.run(run_shell(transport=args.transport, log_level=args.log_level, role=args.role))
    except KeyboardInterrupt:
        pass
    except Exception as err:
        code = getattr(err, "code", "")
        sys.stderr.write(f"[docsagent] fatal: {code + ': ' if code else ''}{err}\n")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
