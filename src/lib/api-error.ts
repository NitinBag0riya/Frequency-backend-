/**
 * F5 — Standardized API error response shape.
 *
 * Every JSON 4xx / 5xx response from this server should be:
 *
 *   {
 *     "error": {
 *       "code":       "<machine-readable string>",   // stable, snake_case
 *       "message":    "<human-readable>",            // safe to render in UI
 *       "details":    {...} | [...]  | undefined,    // optional, FE-renderable
 *       "request_id": "<uuid>"                        // mirrors x-request-id
 *     }
 *   }
 *
 * Goals:
 *   1. Frontend can branch on `error.code` without parsing free-text English.
 *   2. Support tickets can paste `request_id` to find the matching server log.
 *   3. `details` carries structured context (zod issues, missing fields, etc.)
 *      WITHOUT leaking stack traces, DB schema, or internal IDs.
 *
 * NOTE: keep the `error` envelope shallow — clients in the wild already
 * destructure `response.data.error`; nested envelopes break them.
 */
import type { Response } from 'express'

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
    request_id?: string
  }
}

/**
 * Send a standardized JSON error response.
 *
 * Usage:
 *   return apiError(res, 400, 'invalid_filter_key', 'Unknown filter key', { key })
 *
 * `request_id` is pulled from `(res.req as any).id`, which the request-id
 * middleware at the top of `src/index.ts` sets on every incoming request.
 * If the middleware ever stops running first, this gracefully omits the
 * field rather than throwing.
 */
export function apiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const requestId = (res.req as any)?.id as string | undefined
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  }
  return res.status(status).json(body)
}

/**
 * Build an ApiErrorBody without sending — useful for the idempotency cache
 * which needs to persist the response body before it's serialized.
 */
export function buildApiErrorBody(
  code: string,
  message: string,
  details?: unknown,
  requestId?: string,
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  }
}
