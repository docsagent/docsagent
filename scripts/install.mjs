import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getBinaryInfo = () => {
  const platform = process.platform;
  const arch = process.arch;

  let binaryName = "";
  let libs = [];

  if (platform === "darwin") {
    libs = ["libawadb.dylib", "libomp.dylib", "libpdfium.dylib"];
    if (arch === "arm64") {
      binaryName = "docsagent-aarch64-apple-darwin";
    } else if (arch === "x64") {
      binaryName = "docsagent-x86_64-apple-darwin";
    } else {
      binaryName = "docsagent-universal-apple-darwin";
    }
  } else if (platform === "win32") {
    binaryName = "docsagent-x86_64-pc-windows-msvc.exe";
    libs = [
      "libawadb.dll",
      "libcrypto-3-x64.dll",
      "libssl-3-x64.dll",
      "libwinpthread-1.dll",
      "pdfium.dll",
    ];
  } else if (platform === "linux") {
    if (arch === "arm64") {
      binaryName = "docsagent-aarch64-unknown-linux-gnu";
    } else {
      binaryName = "docsagent-x86_64-unknown-linux-gnu";
    }
    libs = ["libawadb.so", "libpdfium.so"];
  }

  return { binaryName, libs };
};

async function install() {
  const binDir = path.join(__dirname, "../bin");
  const { binaryName, libs } = getBinaryInfo();

  if (!binaryName) {
    console.error(`Unsupported platform: ${process.platform} ${process.arch}`);
    return;
  }

  const mainBinaryPath = path.join(binDir, binaryName);

  if (!fs.existsSync(mainBinaryPath)) {
    console.warn(`Warning: Main binary not found at ${mainBinaryPath}. 
    This might happen during local development if you haven't built or placed the binaries yet.`);
    return;
  }

  try {
    // Set executable permissions for the main binary
    if (process.platform !== "win32") {
      fs.chmodSync(mainBinaryPath, 0o755);
      console.log(`Set executable permissions for ${binaryName}`);
    }

    // Verify libraries exist
    for (const lib of libs) {
      const libPath = path.join(binDir, lib);
      if (!fs.existsSync(libPath)) {
        console.warn(`Warning: Library ${lib} not found at ${libPath}.`);
      }
    }

    console.log("DocsAgent binaries verified and configured successfully.");
  } catch (err) {
    console.error(`Post-install configuration failed: ${err.message}`);
  }
}

install();
