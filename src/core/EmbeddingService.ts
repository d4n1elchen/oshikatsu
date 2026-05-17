import { Ollama } from "ollama";
import { getConfig } from "../config";

export interface EmbeddingService {
  enabled(): boolean;
  modelId(): string;
  embed(text: string): Promise<Float32Array>;
}

export class OllamaEmbeddingService implements EmbeddingService {
  private client: Ollama;
  private model: string;
  private isEnabled: boolean;

  constructor() {
    const cfg = getConfig();
    this.isEnabled = cfg.embeddings.enabled;
    this.client = new Ollama({ host: cfg.llm.host });
    this.model = cfg.embeddings.model;
  }

  enabled(): boolean {
    return this.isEnabled;
  }

  modelId(): string {
    return this.model;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await this.client.embed({ model: this.model, input: text });
    const vec = res?.embeddings?.[0];
    if (!vec || vec.length === 0) {
      throw new Error(`Ollama returned no embeddings for model ${this.model}`);
    }
    return new Float32Array(vec);
  }
}

/**
 * Deterministic embedder for tests. Returns the fixture vector for known
 * inputs; falls back to a hash-derived unit vector so unmapped inputs are
 * stable across runs and orthogonal-ish to fixtures.
 */
export class FixedEmbeddingService implements EmbeddingService {
  constructor(
    private map: Map<string, Float32Array> = new Map(),
    private dim: number = 4
  ) {}

  enabled(): boolean {
    return true;
  }

  modelId(): string {
    return "test-fixed";
  }

  async embed(text: string): Promise<Float32Array> {
    const fixed = this.map.get(text);
    if (fixed) return fixed;
    const out = new Float32Array(this.dim);
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) >>> 0;
    }
    for (let i = 0; i < this.dim; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out[i] = ((h & 0xffff) / 0xffff) * 2 - 1;
    }
    return normalizeInPlace(out);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function buildEmbeddingSourceText(opts: {
  title: string;
  venueName?: string | null;
}): string {
  const parts: string[] = [opts.title.trim()];
  if (opts.venueName && opts.venueName.trim()) {
    parts.push(opts.venueName.trim());
  }
  return parts.join(" | ");
}

function normalizeInPlace(v: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i]! * v[i]!;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < v.length; i++) v[i]! /= mag;
  }
  return v;
}

