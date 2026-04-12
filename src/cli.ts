#!/usr/bin/env node
import path from "path";
import { DocsAgent } from "./index.js";

const args = process.argv.slice(2);

const command = args[0];
const remaining = args.slice(1);

const main = async () => {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(`
DocsAgent CLI (Aliases: dag, da)

Usage:
  docsagent server [paths...]       Start persistent service (MCP)
  docsagent search <q>              Search contexts for the query in documents 
  docsagent add <paths...>          Add directories or files to DocsAgent
  docsagent status                  Check engine status
  docsagent list                    List all indexed documents
  docsagent stop                    Stop the background service

Examples:
  docsagent search "Barclays case"  (Formal)
  dag search "Barclays case"        (Geeky)
  da status                         (Short)
      `);
    return;
  }

  // Any command can auto-start the engine if needed
  let initPaths: string[] | undefined = undefined;
  if (command === "server") {
    const paths = remaining.length > 0 ? remaining : ["."];
    initPaths = paths.map(p => path.resolve(p));
  }
  
  switch (command) {
    case "server": {
      const docsagent = new DocsAgent(initPaths);
      const displayPaths = initPaths ? initPaths.join(", ") : ".";
      console.log(`Starting DocsAgent MCP Server (indexing: ${displayPaths})...`);
      await docsagent.startMcpServer();
      break;
    }

    case "add": {
      const docsagent = new DocsAgent(initPaths);
      if (remaining.length === 0) {
        console.error("Please specify at least one directory or file to add.");
        process.exit(1);
      }
      const absolutePaths = remaining.map(p => path.resolve(p));
      await docsagent.add(absolutePaths);
      console.log(`Added ${absolutePaths.join(", ")} to DocsAgent.`);
      break;
    }

    case "search": {
      const docsagent = new DocsAgent(initPaths);
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
    }

    case "status": {
      const docsagent = new DocsAgent(initPaths);
      const s = await docsagent.status();
      console.log(JSON.stringify(s, null, 2));
      break;
    }

    case "list": {
      const docsagent = new DocsAgent(initPaths);
      const l = await docsagent.list();
      if (l.length === 0) {
        console.log("No documents indexed.");
      } else {
        l.forEach(p => console.log(`- ${p}`));
      }
      break;
    }
  
    case "stop":
    case "close": {
      const docsagent = new DocsAgent(initPaths);
      console.log(`Stopping DocsAgent service...`);
      await docsagent.close();
      console.log("Service stopped.");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(`
DocsAgent CLI (Aliases: dag, da)

Usage:
  docsagent server [paths...]       Start persistent service (MCP)
  docsagent search <q> [paths...]    Search for documents
  docsagent add <paths...>          Add directories or files to DocsAgent
  docsagent status                  Check engine status
  docsagent list                    List all indexed documents
  docsagent stop                    Stop the background service

Examples:
  docsagent search "Barclays case"  (Formal)
  dag search "Barclays case"        (Geeky)
  da status                         (Short)
      `);
      process.exit(1);
  }
};

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  process.exit(0);
});
