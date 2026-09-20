#!/usr/bin/env python3
"""Smoke test: drive the Python MCP shell over stdio against the live core."""

import json
import os
import subprocess
import sys

BIN = os.path.join(os.path.dirname(__file__), ".venv", "bin", "python")
proc = subprocess.Popen(
    [BIN, "-m", "docsagent_mcp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    cwd=os.path.dirname(__file__),
)

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

def recv():
    line = proc.stdout.readline()
    if not line:
        raise SystemExit("server closed stdout")
    return json.loads(line)

send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                 "clientInfo": {"name": "smoke", "version": "0"}}})
init = recv()
print("1. serverInfo:", json.dumps(init["result"]["serverInfo"]))
send({"jsonrpc": "2.0", "method": "notifications/initialized"})

send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
tools = recv()["result"]["tools"]
print("2. tools:", [t["name"] for t in tools])
print("   search annotations:", json.dumps(next(t for t in tools if t["name"] == "search").get("annotations")))

def call(i, name, args):
    send({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}})
    res = recv()["result"]
    payload = json.loads(res["content"][0]["text"])
    return res, payload

res, payload = call(3, "list_sources", {})
print("3. list_sources:", json.dumps(payload["sources"][0], ensure_ascii=False)[:220])

res, payload = call(4, "search", {"query": "model", "target": ["items"], "depth": "snippets", "k": 3})
first = (payload.get("results") or [{}])[0]
print("4. search:", "total", payload.get("total"), "| first:", first.get("id"), "| snippets:", len(first.get("snippets") or []))
item_id = first.get("id")

res, payload = call(5, "get_content", {"id": item_id, "mode": "passages", "query": "model"})
print("5. get_content passages:", len(payload.get("passages", [])))

res, payload = call(6, "get_metadata", {"id": item_id, "include": ["metadata"]})
print("6. get_metadata title:", (payload.get("metadata") or {}).get("title", "")[:60])

res, payload = call(7, "add_note", {"id": item_id, "content": "x"})
print("7. write gate (enableWrites=false):", json.loads(res["content"][0]["text"])["error"]["code"])

res, payload = call(8, "search", {"query": "model", "target": ["annotations"]})
print("8. bad-target/error shape check isError:", res.get("isError"), json.loads(res["content"][0]["text"]).get("error", {}).get("code", "(ok)"))

proc.stdin.close()
proc.wait(timeout=10)
print("exit code:", proc.returncode)
