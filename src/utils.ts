import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getBinaryPath = () => {
  const platform = process.platform;
  const arch = process.arch;

  let binaryName = "";

  if (platform === "darwin") {
    if (arch === "arm64") {
      binaryName = "docsagent-aarch64-apple-darwin";
    } else if (arch === "x64") {
      binaryName = "docsagent-x86_64-apple-darwin";
    } else {
      binaryName = "docsagent-universal-apple-darwin";
    }
  } else if (platform === "win32") {
    binaryName = "docsagent-x86_64-pc-windows-msvc.exe";
  } else if (platform === "linux") {
    if (arch === "arm64") {
      binaryName = "docsagent-aarch64-unknown-linux-gnu";
    } else {
      binaryName = "docsagent-x86_64-unknown-linux-gnu";
    }
  }

  const fullPath = path.join(__dirname, "../bin", binaryName);

  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Binary not found for platform "${platform}" and architecture "${arch}". Expected at: ${fullPath}`
    );
  }

  return fullPath;
};
