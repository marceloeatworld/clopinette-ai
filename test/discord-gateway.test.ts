import { describe, expect, it } from "vitest";
import type { DiscordMessage } from "../src/gateway/discord.js";
import { shouldProcessDiscordMessage, stripDiscordBotMentions } from "../src/gateway/discord.js";

function makeMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "msg_1",
    channel_id: "chan_1",
    author: { id: "user_1", username: "marcelo" },
    content: "hello",
    timestamp: "2026-04-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("discord gateway routing", () => {
  it("always processes DMs", () => {
    const message = makeMessage({ guild_id: undefined });
    expect(shouldProcessDiscordMessage(message, { applicationId: "bot_1" })).toBe(true);
  });

  it("requires mention in guild channels by default", () => {
    const message = makeMessage({ guild_id: "guild_1" });
    expect(shouldProcessDiscordMessage(message, { applicationId: "bot_1" })).toBe(false);
  });

  it("accepts guild replies to the bot without a fresh mention", () => {
    const message = makeMessage({
      guild_id: "guild_1",
      referenced_message: {
        id: "msg_0",
        author: { id: "bot_1", username: "clopinette" },
      },
    });
    expect(shouldProcessDiscordMessage(message, { applicationId: "bot_1" })).toBe(true);
  });

  it("accepts guild messages that mention the bot", () => {
    const message = makeMessage({
      guild_id: "guild_1",
      content: "<@bot_1> help me",
    });
    expect(shouldProcessDiscordMessage(message, { applicationId: "bot_1" })).toBe(true);
  });

  it("accepts configured free-response channels", () => {
    const message = makeMessage({ guild_id: "guild_1", channel_id: "chan_free" });
    expect(
      shouldProcessDiscordMessage(message, {
        applicationId: "bot_1",
        freeResponseChannels: ["chan_free"],
      }),
    ).toBe(true);
  });

  it("strips bot mentions before prompt execution", () => {
    expect(stripDiscordBotMentions("<@!bot_1>   summarize this", "bot_1")).toBe("summarize this");
  });
});
