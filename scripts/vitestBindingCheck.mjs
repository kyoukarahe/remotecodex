import { join } from "node:path";

export function detectExpectedRolldownBindings(platform, arch) {
  if (platform === "linux" && arch === "x64") {
    return ["binding-linux-x64-gnu", "binding-linux-x64-musl"];
  }
  if (platform === "darwin" && arch === "arm64") {
    return ["binding-darwin-arm64"];
  }
  if (platform === "darwin" && arch === "x64") {
    return ["binding-darwin-x64"];
  }
  if (platform === "win32" && arch === "x64") {
    return ["binding-win32-x64-msvc"];
  }
  if (platform === "win32" && arch === "arm64") {
    return ["binding-win32-arm64-msvc"];
  }
  return [`binding-${platform}-${arch}`];
}

export function verifyVitestBindingsInstalled({ rootDir, existsSync, platform, arch }) {
  const rolldownDir = join(rootDir, "node_modules", "@rolldown");
  if (!existsSync(rolldownDir)) {
    return {
      ok: false,
      expectedBindings: [],
      message:
        "Missing optional rolldown native bindings under node_modules/@rolldown. Reinstall dependencies before running vitest.",
    };
  }

  const expectedBindings = detectExpectedRolldownBindings(platform, arch);
  const hasBinding = expectedBindings.some((name) => existsSync(join(rolldownDir, name)));
  if (!hasBinding) {
    return {
      ok: false,
      expectedBindings,
      message:
        `Vitest requires one of the platform-specific rolldown bindings (${expectedBindings.join(", ")}) but none are installed. ` +
        `Reinstall node_modules so npm restores the correct optional dependency for ${platform}-${arch}.`,
    };
  }

  return { ok: true, expectedBindings };
}
