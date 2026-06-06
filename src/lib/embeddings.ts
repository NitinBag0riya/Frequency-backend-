/**
 * Text embeddings for the AI knowledge base — OPTIONAL accelerator.
 *
 * Important: Anthropic does NOT offer an embeddings API (their guidance is to
 * use a third-party embeddings provider). So we cannot embed with the Anthropic
 * key we already use for the responder. Embeddings here are therefore OPTIONAL:
 *
 *   - OPENAI_API_KEY present → OpenAI `text-embedding-3-small` (dimensions:384)
 *     powers true vector / semantic retrieval via pgvector.
 *   - otherwise              → embeddings are disabled and retrieval falls back
 *     to the Anthropic-native path: keyword recall + giving Claude (the model
 *     we already pay for) the knowledge as context so IT does the semantic
 *     matching (e.g. "two-bedroom" ⇄ "2 BHK"). No new key, no native deps.
 *
 * 384 dims is fixed so the pgvector(384) column is provider-stable.
 */

export const EMBED_DIM = 384

/** True only when a hosted embedding provider is configured. */
export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY
}

/** Identifier stored in tenant_knowledge_chunks.embed_model for provenance. */
export function embedModelName(): string | null {
  if (process.env.OPENAI_API_KEY) return 'openai:text-embedding-3-small:384'
  return null
}

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

/** Returns [] when no hosted provider is configured (retrieval then uses the
 *  Anthropic-context fallback). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) return []
  const clean = texts.map(t => (t ?? '').trim()).filter(Boolean)
  if (clean.length === 0) return []
  return openaiEmbed(clean)
}

export async function embedText(text: string): Promise<number[] | null> {
  const [v] = await embedTexts([text])
  return v ?? null
}

/** pgvector text literal, e.g. '[0.12,-0.03,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}
