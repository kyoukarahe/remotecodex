import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { RemoteCodexMapping, SessionStore } from "./types.js";

export class InMemorySessionStore implements SessionStore {
  constructor(private mappings: RemoteCodexMapping[] = []) {}

  async list(): Promise<RemoteCodexMapping[]> {
    return [...this.mappings];
  }

  async saveAll(mappings: RemoteCodexMapping[]): Promise<void> {
    this.mappings = [...mappings];
  }
}

export class JsonFileSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<RemoteCodexMapping[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as RemoteCodexMapping[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async saveAll(mappings: RemoteCodexMapping[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(mappings, null, 2), "utf8");
  }
}
