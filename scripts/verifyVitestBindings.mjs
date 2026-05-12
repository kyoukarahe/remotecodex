import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { verifyVitestBindingsInstalled } from "./vitestBindingCheck.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const result = verifyVitestBindingsInstalled({
  rootDir,
  existsSync,
  platform: process.platform,
  arch: process.arch,
});

if (!result.ok) {
  fail(result.message ?? "Vitest bindings verification failed");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
