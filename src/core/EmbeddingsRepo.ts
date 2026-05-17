import { inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { eventEmbeddings } from "../db/schema";
import { getConfig } from "../config";
import { buildEmbeddingSourceText, type EmbeddingService } from "./EmbeddingService";
import { tagged } from "./logger";

const log = tagged("EmbeddingsRepo");

type DbInstance = typeof defaultDb;

export class EmbeddingsRepo {
  constructor(
    private db: DbInstance,
    private service: EmbeddingService
  ) {}

  enabled(): boolean {
    return this.service.enabled();
  }

  modelId(): string {
    return this.service.modelId();
  }

  cosineThreshold(): number {
    return getConfig().embeddings.cosineThreshold;
  }

  /**
   * Compute and upsert a normalized event's embedding. Best-effort: failures
   * are logged and swallowed so a downed Ollama / missing model doesn't break
   * the resolver loop. The caller can re-run later (e.g. on next merge or
   * operator edit) to populate the row.
   */
  async embedAndStore(opts: {
    normalizedEventId: string;
    title: string;
    venueName?: string | null;
  }): Promise<void> {
    if (!this.service.enabled()) return;
    const sourceText = buildEmbeddingSourceText(opts);
    try {
      const vec = await this.service.embed(sourceText);
      const buf = float32ToBuffer(vec);
      const now = new Date();
      this.db.insert(eventEmbeddings).values({
        normalizedEventId: opts.normalizedEventId,
        model: this.service.modelId(),
        dim: vec.length,
        vector: buf,
        sourceText,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: eventEmbeddings.normalizedEventId,
        set: {
          model: this.service.modelId(),
          dim: vec.length,
          vector: buf,
          sourceText,
          updatedAt: now,
        },
      }).run();
    } catch (e) {
      log.warn(`Failed to embed normalized event ${opts.normalizedEventId}: ${e}`);
    }
  }

  async embedQuery(opts: {
    title: string;
    venueName?: string | null;
  }): Promise<Float32Array | null> {
    if (!this.service.enabled()) return null;
    try {
      return await this.service.embed(buildEmbeddingSourceText(opts));
    } catch (e) {
      log.warn(`Failed to embed query text: ${e}`);
      return null;
    }
  }

  /**
   * Batch-load cached vectors for the given normalized-event IDs. Rows whose
   * `model` doesn't match the currently-configured embedder are skipped — a
   * model swap invalidates the cache rather than silently mixing spaces.
   */
  loadForNormalizedEvents(ids: string[]): Map<string, Float32Array> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(eventEmbeddings)
      .where(inArray(eventEmbeddings.normalizedEventId, ids))
      .all();
    const out = new Map<string, Float32Array>();
    for (const r of rows) {
      if (r.model !== this.service.modelId()) continue;
      out.set(r.normalizedEventId, bufferToFloat32(r.vector as Buffer | Uint8Array));
    }
    return out;
  }
}

function float32ToBuffer(v: Float32Array): Buffer {
  // Copy out — the underlying ArrayBuffer may be a shared pool slice.
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

function bufferToFloat32(b: Buffer | Uint8Array): Float32Array {
  // Copy into a fresh 4-byte-aligned ArrayBuffer.
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}
