export const DISCORD_MESSAGE_LIMIT = 2000;

export function splitDiscordMessage(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (limit < 1) {
    throw new Error("Discord message split limit must be positive");
  }

  if (content.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += limit) {
    chunks.push(content.slice(offset, offset + limit));
  }
  return chunks;
}
