import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { embedText } from "./memory/vector-search.js";

/**
 * One-shot Workflow that hydrates the Vectorize index with embeddings for all
 * pre-existing `session_messages` rows in a user's DO.
 *
 * Why a Workflow and not an RPC loop:
 * - Retry-safe per batch — if Workers AI rate-limits at batch N, batches 1..N-1 stay committed
 * - Resumable across restarts — state is carried by WorkflowEntrypoint
 * - Observable via `wrangler workflows instances list backfill-vectors-workflow`
 * - Runs detached — you kick it off with `agent.startBackfillVectors()` and walk away
 *
 * The workflow fetches message batches from the parent DO via RPC (the DO is
 * the source of truth for session_messages), embeds them, and upserts to Vectorize.
 */
export interface BackfillParams {
  userId: string;          // Parent DO name
  batchSize?: number;      // How many messages per step.do batch (default 50)
  startOffset?: number;    // Resume offset (for manual restarts)
}

interface BackfillStats {
  processed: number;
  embedded: number;
  skipped: number;
  finalOffset: number;
}

export class BackfillVectorsWorkflow extends WorkflowEntrypoint<Env, BackfillParams> {
  async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep): Promise<BackfillStats> {
    const { userId } = event.payload;
    const batchSize = event.payload.batchSize ?? 50;
    let offset = event.payload.startOffset ?? 0;

    const stats: BackfillStats = { processed: 0, embedded: 0, skipped: 0, finalOffset: offset };

    // Cap at 10k messages per workflow run — bigger history can be re-kicked manually.
    const MAX_MESSAGES = 10_000;
    const MAX_BATCHES = Math.ceil(MAX_MESSAGES / batchSize);

    for (let i = 0; i < MAX_BATCHES; i++) {
      const currentOffset = offset;

      const batch = await step.do(
        `fetch-batch-${i}`,
        { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" },
        async () => {
          const stub = this.env.CLOPINETTE_AGENT.get(this.env.CLOPINETTE_AGENT.idFromName(userId));
          return await stub.fetchMessagesForBackfill(currentOffset, batchSize);
        },
      );

      if (batch.length === 0) break;

      await step.do(
        `embed-batch-${i}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          for (const msg of batch) {
            const embedding = await embedText(this.env.AI, msg.content);
            if (!embedding) {
              stats.skipped++;
              continue;
            }
            await this.env.VECTORS.upsert([{
              id: `msg_${userId}_${msg.id}`,
              values: embedding,
              metadata: { userId, sessionId: msg.sessionId, role: msg.role, messageId: msg.id },
            }]);
            stats.embedded++;
          }
          stats.processed += batch.length;
        },
      );

      offset += batch.length;
      stats.finalOffset = offset;

      if (batch.length < batchSize) break;
    }

    return stats;
  }
}
