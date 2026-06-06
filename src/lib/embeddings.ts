/**
 * Provider-agnostic text embeddings for the AI knowledge base.
 *
 * One fixed dimension (384) is used across providers so a single
 * pgvector(384) column works regardless of which provider is active:
 *   - OPENAI_API_KEY present → OpenAI `text-embedding-3-small` with
 *     `dimensions: 384` (hosted, best quality/reliability).
 *   - otherwise              → local `Xenova/all-MiniLM-L6-v2` (384-dim) via
 *     transformers.js — no API key, no per-call cost; downloads a ~90MB model
 *     on first use and runs in-process (needs a long-running Node backend).
 *
 * Add an OPENAI_API_KEY any time and the system upgrades automatically — no
 * schema change (re-embed via the backfill script to switch model on old rows).
 */

export const EMBED_DIM = 384

/** Identifier stored in tenant_knowledge_chunks.embed_model for provenance. */
export function embedModelName(): string {
  if (process.env.OPENAI_API_KEY) return 'openai:text-embedding-3-small:384'
  return 'local:all-MiniLM-L6-v2:384'
}

export function embeddingsEnabled(): boolean {
  // Local is always available (lazy model download); hosted when a key is set.
  return true
}

// ── OpenAI (hosted) ───────────────────────────────────────────────────────────
async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts, dimensions: EMBED_DIM }),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json() as any
  return (json.data as any[]).map(d => d.embedding as number[])
}

// ── Local (transformers.js) ───────────────────────────────────────────────────
// Lazy singleton — importing @xenova/transformers pulls in onnxruntime, so we
// only load it when no hosted provider is configured AND an embed is requested.
let _localPipe: Promise<any> | null = null
function getLocalPipe(): Promise<any> {
  if (!_localPipe) {
    _localPipe = import('@xenova/transformers').then(async (mod: any) => {
      // Quantized model keeps memory/CPU modest; mean-pool + normalize gives a
      // unit vector suitable for cosine distance.
      return mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true })
    })
  }
  return _localPipe
}

async function localEmbed(texts: string[]): Promise<number[][]> {
  const pipe = await getLocalPipe()
  const out: number[][] = []
  for (const t of texts) {
    const r = await pipe(t, { pooling: 'mean', normalize: true })
    out.push(Array.from(r.data as Float32Array))
  }
  return out
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const clean = texts.map(t => (t ?? '').trim()).filter(Boolean)
  if (clean.length === 0) return []
  if (process.env.OPENAI_API_KEY) return openaiEmbed(clean)
  return localEmbed(clean)
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedTexts([text])
  return v
}

/** pgvector text literal, e.g. '[0.12,-0.03,...]' — what PostgREST casts to vector. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}
