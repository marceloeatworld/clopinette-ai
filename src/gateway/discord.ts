/**
 * Discord Interactions gateway (slash commands only).
 *
 * Limitation: Discord regular messages require a persistent WebSocket (Gateway),
 * which is not compatible with Cloudflare Workers. This gateway only handles
 * slash commands and interactive components via HTTP POST.
 *
 * Secrets needed:
 *   DISCORD_PUBLIC_KEY      — Ed25519 signature verification
 *   DISCORD_APPLICATION_ID  — for followup webhook URLs
 *   DISCORD_TOKEN           — bot token for REST API calls
 *
 * Setup:
 *   1. Create application at discord.com/developers/applications
 *   2. Set Interactions Endpoint URL to /webhook/discord
 *   3. Register slash commands via REST API (e.g. /ask)
 *   4. Set secrets via wrangler secret put
 *
 * User ID: interaction.member.user.id (guild) or interaction.user.id (DM)
 * DO name: dc_{userId}
 * Must respond within 3 seconds (use type 5 DEFERRED for LLM calls)
 */

// TODO: implement when needed
// - verifyDiscordSignature(publicKey, timestamp, body, signature) — Ed25519
// - handleDiscordInteraction(request, ctx) — parse interaction, PONG, route
// - respondToInteraction(type, data) — sync response or deferred
// - editOriginalResponse(appId, token, content) — PATCH followup
// - registerSlashCommands(appId, token) — PUT global commands
