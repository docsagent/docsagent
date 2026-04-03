#!/usr/bin/env node
import path from "path";
import { DocsAgent } from "./index.js";

const args = process.argv.slice(2);

// Port argument parsing
let port = 18688;
const pIdx = args.findIndex(a => a === "--port" || a === "-p");
if (pIdx !== -1 && args[pIdx + 1]) {
  port = parseInt(args[pIdx + 1]);
  args.splice(pIdx, 2);
}

const command = args[0];
const remaining = args.slice(1);

const main = async () => {
  // Any command can auto-start the engine if needed
  let initPaths: string[] | undefined = undefined;
  if (command === "server") {
    const paths = remaining.length > 0 ? remaining : ["."];
    initPaths = paths.map(p => path.resolve(p));
  }
  
  const docsagent = new DocsAgent(initPaths, port);

  switch (command) {
    case "server":
      const displayPaths = initPaths ? initPaths.join(", ") : ".";
      console.log(`Starting DocsAgent MCP Server on port ${port} (indexing: ${displayPaths})...`);
      await docsagent.startMcpServer();
      break;

    case "add":
      if (remaining.length === 0) {
        console.error("Please specify at least one directory or file to add.");
        process.exit(1);
      }
      const absolutePaths = remaining.map(p => path.resolve(p));
      await docsagent.add(absolutePaths);
      console.log(`Added ${absolutePaths.join(", ")} to DocsAgent.`);
      break;

    case "search":
      const query = remaining.join(" ");
      if (!query) {
        console.error("Please specify a search query.");
        process.exit(1);
      }
      const results = await docsagent.search(query);
      if (results.length === 0) {
        console.log("No results found.");
      } else {
        results.forEach((r, i) => {
          console.log(`${i + 1}. [Score: ${r.score.toFixed(2)}]${r.path ? ` ${r.path}` : ""}${r.page ? ` (Page ${r.page})` : ""}`);
          console.log(`   Context: ${r.context}`);
          console.log("---");
        });

      }

      break;

    case "status":
      const s = await docsagent.status();
      console.log(JSON.stringify(s, null, 2));
      break;

    case "list":
      const l = await docsagent.list();
      if (l.length === 0) {
        console.log("No documents indexed.");
      } else {
        l.forEach(p => console.log(`- ${p}`));
      }
      break;

    case "remove":
      if (!remaining[0]) {
        console.error("Please specify a path to remove.");
        process.exit(1);
      }
      const absPathToRemove = path.resolve(remaining[0]);
      await docsagent.remove(absPathToRemove);
      console.log(`Removed ${absPathToRemove} from DocsAgent.`);
      break;

    case "stop":
    case "close":
      console.log(`Stopping DocsAgent service on port ${port}...`);
      await docsagent.close();
      console.log("Service stopped.");
      break;

    default:
      console.log(`
DocsAgent CLI (Aliases: dag, da)

Usage:
  docsagent server [paths...] [--port <n>] Start persistent service (MCP)
  docsagent search <q> [paths...] [--port <n>] Search for documents
  docsagent add <paths...> [--port <n>]    Add directories or files to DocsAgent
  docsagent status [--port <n>]            Check engine status
  docsagent list [--port <n>]              List all indexed documents
  docsagent remove <path> [--port <n>]     Remove a document/folder from index
  docsagent stop [--port <n>]              Stop the background service

Examples:
  docsagent search "Barclays case"  (Formal)
  dag search "Barclays case"        (Geeky)
  da status                         (Short)

Options:
  -p, --port <n>  Port for the local service (default: 18688)
      `);
      break;
  }
};

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  process.exit(0);
});
