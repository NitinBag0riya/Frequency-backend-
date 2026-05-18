/**
 * Meta WhatsApp Flows JSON schema — validator + reference spec.
 *
 * Source of truth (current as of Flow JSON v7.1):
 *   - https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 *   - https://developers.facebook.com/docs/whatsapp/flows/reference/components
 *   - https://developers.facebook.com/docs/whatsapp/flows/reference/actions
 *
 * We intentionally hand-write the validator instead of pulling in ajv:
 *   1. Zero new deps; keeps the deploy bundle small.
 *   2. We get to emit human-readable error paths ("screens[1].layout.children[2].label is required")
 *      which is what the chat-edit loop feeds back into Claude on retry.
 *   3. Meta's spec is component-shape heavy, not deeply recursive — a single
 *      validateDefinition() pass is faster + clearer than maintaining a JSON
 *      Schema document for every component variant.
 *
 * What we enforce strictly (so we never publish broken flows to Meta):
 *   - version is "7.1" (the only one we support; bump explicitly when Meta
 *     adds breaking changes).
 *   - screens: non-empty array; each has unique `id`, a `title`, and a
 *     SingleColumnLayout with `children`.
 *   - At least ONE screen must have `terminal: true` AND `success: true`
 *     (otherwise Meta rejects on publish).
 *   - Every Footer's on-click-action `next.name` references an existing screen
 *     id (or is `complete` for terminal screens). This is the #1 source of
 *     bad-flow rejections; we catch it locally so the user never sees Meta's
 *     opaque error.
 *   - Component types are from the allowed list; required props per type are
 *     present; reserved screen ids ('SUCCESS') aren't used by accident.
 *
 * What we DON'T enforce (Meta will, on publish):
 *   - DataChannel URI reachability.
 *   - `data` schema reference resolution (we accept any JSON-Schema-shaped object).
 *   - Image base64 size limits.
 *
 * Exports:
 *   - validateDefinition(def) → { valid, errors }
 *   - FLOW_SPEC_FOR_PROMPT — the spec excerpt we paste into Claude's system
 *     prompt so it generates valid JSON on the first try.
 *   - DEFAULT_DEFINITION — what `POST /api/wa-flows` seeds for a new draft.
 */

export const FLOW_VERSION = '7.1'

/** Components our validator + preview both understand. Sourced from Meta docs. */
const ALLOWED_COMPONENTS = new Set([
  'TextHeading',
  'TextSubheading',
  'TextBody',
  'TextCaption',
  'RichText',
  'TextInput',
  'TextArea',
  'CheckboxGroup',
  'RadioButtonsGroup',
  'Dropdown',
  'OptIn',
  'DatePicker',
  'Image',
  'EmbeddedLink',
  'Footer',
  'PhotoPicker',
  'DocumentPicker',
])

/** Reserved screen id Meta uses to denote the success completion. Don't shadow. */
const RESERVED_SCREEN_IDS = new Set(['SUCCESS'])

export interface FlowComponent {
  type: string
  name?: string
  label?: string
  text?: string
  required?: boolean
  'helper-text'?: string
  'data-source'?: Array<{ id: string; title: string; description?: string }>
  src?: string
  'on-click-action'?: FlowAction
  [k: string]: unknown
}

export interface FlowAction {
  name: 'navigate' | 'complete' | 'data_exchange' | 'open_url' | 'update_data'
  next?: { type: 'screen' | 'plugin'; name: string }
  payload?: Record<string, unknown>
  url?: string
}

export interface FlowScreen {
  id: string
  title: string
  data?: Record<string, unknown>
  terminal?: boolean
  success?: boolean
  refresh_on_back?: boolean
  layout: {
    type: 'SingleColumnLayout'
    children: FlowComponent[]
  }
}

export interface FlowDefinition {
  version: string
  /** Optional data channel for runtime data exchange — pure URL + verify_action. */
  data_api_version?: string
  routing_model?: Record<string, string[]>
  screens: FlowScreen[]
}

export interface ValidationError {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/** Seed for a new DRAFT — single empty screen that's already valid. */
export const DEFAULT_DEFINITION: FlowDefinition = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'WELCOME',
      title: 'Welcome',
      terminal: true,
      success: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Welcome' },
          { type: 'TextBody', text: 'This flow is brand new — edit it in the chat to the left to add real screens.' },
          {
            type: 'Footer',
            label: 'Done',
            'on-click-action': { name: 'complete', payload: {} },
          },
        ],
      },
    },
  ],
}

// ── Validator ───────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pushErr(errors: ValidationError[], path: string, message: string) {
  errors.push({ path, message })
}

/**
 * Validate a Flow definition. Returns ALL errors found (not just the first)
 * so the chat-edit loop can include them in the next prompt to Claude.
 */
export function validateDefinition(def: unknown): ValidationResult {
  const errors: ValidationError[] = []

  if (!isObject(def)) {
    return { valid: false, errors: [{ path: '$', message: 'definition must be a JSON object' }] }
  }

  // ── Top-level ───────────────────────────────────────────────────────────
  if (def.version !== FLOW_VERSION) {
    pushErr(errors, 'version', `must be "${FLOW_VERSION}" (got ${JSON.stringify(def.version)})`)
  }
  if (!Array.isArray(def.screens)) {
    pushErr(errors, 'screens', 'must be an array')
    return { valid: false, errors }
  }
  if (def.screens.length === 0) {
    pushErr(errors, 'screens', 'must contain at least one screen')
  }

  // Build screen-id index for cross-reference checks (NavigateAction targets).
  const screenIds = new Set<string>()
  for (let i = 0; i < def.screens.length; i++) {
    const s = def.screens[i] as any
    if (isObject(s) && typeof s.id === 'string') {
      if (screenIds.has(s.id)) {
        pushErr(errors, `screens[${i}].id`, `duplicate screen id "${s.id}"`)
      } else {
        screenIds.add(s.id)
      }
    }
  }

  // ── Per-screen ──────────────────────────────────────────────────────────
  let hasTerminalSuccess = false
  for (let i = 0; i < def.screens.length; i++) {
    const sRaw = def.screens[i]
    const path = `screens[${i}]`
    if (!isObject(sRaw)) {
      pushErr(errors, path, 'must be an object'); continue
    }
    const s = sRaw as Record<string, unknown>

    if (typeof s.id !== 'string' || s.id.length === 0) {
      pushErr(errors, `${path}.id`, 'required string')
    } else if (RESERVED_SCREEN_IDS.has(s.id)) {
      pushErr(errors, `${path}.id`, `"${s.id}" is reserved by Meta — choose another id`)
    } else if (!/^[A-Z][A-Z0-9_]*$/.test(s.id)) {
      pushErr(errors, `${path}.id`, `must be SCREAMING_SNAKE_CASE (got "${s.id}")`)
    }

    if (typeof s.title !== 'string' || s.title.length === 0) {
      pushErr(errors, `${path}.title`, 'required string')
    }

    if (s.terminal === true && s.success === true) hasTerminalSuccess = true

    if (!isObject(s.layout)) {
      pushErr(errors, `${path}.layout`, 'required object'); continue
    }
    const layout = s.layout as Record<string, unknown>
    if (layout.type !== 'SingleColumnLayout') {
      pushErr(errors, `${path}.layout.type`, 'must be "SingleColumnLayout"')
    }
    if (!Array.isArray(layout.children)) {
      pushErr(errors, `${path}.layout.children`, 'must be an array'); continue
    }
    if (layout.children.length === 0) {
      pushErr(errors, `${path}.layout.children`, 'must contain at least one component')
    }

    // ── Per-component ────────────────────────────────────────────────────
    const componentNames = new Set<string>()
    for (let j = 0; j < layout.children.length; j++) {
      const cRaw = layout.children[j]
      const cPath = `${path}.layout.children[${j}]`
      if (!isObject(cRaw)) {
        pushErr(errors, cPath, 'must be an object'); continue
      }
      const c = cRaw as Record<string, unknown>

      if (typeof c.type !== 'string') {
        pushErr(errors, `${cPath}.type`, 'required string'); continue
      }
      if (!ALLOWED_COMPONENTS.has(c.type)) {
        pushErr(errors, `${cPath}.type`, `unknown component "${c.type}"; allowed: ${[...ALLOWED_COMPONENTS].join(', ')}`)
        continue
      }

      // Per-type required-props.
      switch (c.type) {
        case 'TextHeading':
        case 'TextSubheading':
        case 'TextBody':
        case 'TextCaption':
        case 'RichText':
          if (typeof c.text !== 'string' || c.text.length === 0) {
            pushErr(errors, `${cPath}.text`, 'required non-empty string')
          }
          break
        case 'TextInput':
        case 'TextArea':
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          if (typeof c.name !== 'string' || c.name.length === 0) {
            pushErr(errors, `${cPath}.name`, 'required non-empty string')
          }
          break
        case 'Dropdown':
        case 'CheckboxGroup':
        case 'RadioButtonsGroup':
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          if (typeof c.name !== 'string' || c.name.length === 0) {
            pushErr(errors, `${cPath}.name`, 'required non-empty string')
          }
          if (!Array.isArray(c['data-source']) || (c['data-source'] as unknown[]).length === 0) {
            pushErr(errors, `${cPath}.data-source`, 'required non-empty array of {id,title}')
          } else {
            (c['data-source'] as any[]).forEach((opt, k) => {
              if (!isObject(opt) || typeof opt.id !== 'string' || typeof opt.title !== 'string') {
                pushErr(errors, `${cPath}.data-source[${k}]`, 'must be { id: string, title: string }')
              }
            })
          }
          break
        case 'OptIn':
          if (typeof c.name !== 'string' || c.name.length === 0) {
            pushErr(errors, `${cPath}.name`, 'required non-empty string')
          }
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          break
        case 'DatePicker':
          if (typeof c.name !== 'string' || c.name.length === 0) {
            pushErr(errors, `${cPath}.name`, 'required non-empty string')
          }
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          break
        case 'Image':
          if (typeof c.src !== 'string' || c.src.length === 0) {
            pushErr(errors, `${cPath}.src`, 'required base64 string')
          }
          break
        case 'EmbeddedLink':
          if (typeof c.text !== 'string' || c.text.length === 0) {
            pushErr(errors, `${cPath}.text`, 'required non-empty string')
          }
          if (!isObject(c['on-click-action'])) {
            pushErr(errors, `${cPath}.on-click-action`, 'required action object')
          }
          break
        case 'PhotoPicker':
        case 'DocumentPicker':
          if (typeof c.name !== 'string' || c.name.length === 0) {
            pushErr(errors, `${cPath}.name`, 'required non-empty string')
          }
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          break
        case 'Footer':
          if (typeof c.label !== 'string' || c.label.length === 0) {
            pushErr(errors, `${cPath}.label`, 'required non-empty string')
          }
          if (!isObject(c['on-click-action'])) {
            pushErr(errors, `${cPath}.on-click-action`, 'required action object')
          } else {
            validateAction(c['on-click-action'] as Record<string, unknown>, screenIds, !!s.terminal, `${cPath}.on-click-action`, errors)
          }
          break
      }

      // Duplicate `name` within the same screen would clash on submission.
      if (typeof c.name === 'string' && c.name.length > 0) {
        if (componentNames.has(c.name)) {
          pushErr(errors, `${cPath}.name`, `duplicate name "${c.name}" in this screen`)
        }
        componentNames.add(c.name)
      }
    }
  }

  if (!hasTerminalSuccess && Array.isArray(def.screens) && def.screens.length > 0) {
    pushErr(errors, 'screens', 'at least one screen must have terminal:true AND success:true (Meta requires a completion target)')
  }

  return { valid: errors.length === 0, errors }
}

function validateAction(
  action: Record<string, unknown>,
  screenIds: Set<string>,
  parentIsTerminal: boolean,
  basePath: string,
  errors: ValidationError[],
): void {
  const name = action.name
  if (typeof name !== 'string') {
    pushErr(errors, `${basePath}.name`, 'required string ("navigate" | "complete" | "data_exchange" | "open_url" | "update_data")')
    return
  }
  if (!['navigate', 'complete', 'data_exchange', 'open_url', 'update_data'].includes(name)) {
    pushErr(errors, `${basePath}.name`, `unknown action "${name}"`)
    return
  }

  if (name === 'navigate') {
    if (!isObject(action.next)) {
      pushErr(errors, `${basePath}.next`, 'required { type: "screen", name: "<screen_id>" }')
      return
    }
    const next = action.next as Record<string, unknown>
    if (next.type !== 'screen') {
      pushErr(errors, `${basePath}.next.type`, 'must be "screen"')
    }
    if (typeof next.name !== 'string') {
      pushErr(errors, `${basePath}.next.name`, 'must be a screen id string')
    } else if (!screenIds.has(next.name as string)) {
      pushErr(errors, `${basePath}.next.name`, `references unknown screen id "${next.name}"`)
    }
  } else if (name === 'complete') {
    if (!parentIsTerminal) {
      pushErr(errors, basePath, '"complete" action only allowed on a Footer of a terminal screen')
    }
  } else if (name === 'open_url') {
    if (typeof action.url !== 'string' || !/^https?:\/\//.test(action.url as string)) {
      pushErr(errors, `${basePath}.url`, 'required http(s) URL')
    }
  }
  // data_exchange + update_data have looser shapes — runtime payload is
  // tenant-defined. Meta validates the rest on publish.
}

// ── Reference spec for Claude's system prompt ───────────────────────────────
//
// We embed a *condensed* version of Meta's reference. The full Meta docs are
// ~30 pages; pasting them all would burn cache budget and confuse the model
// with stale content. This excerpt covers exactly the surface validateDefinition
// enforces — so what Claude generates is what we can validate locally.
//
// When Meta ships a new component type, update ALLOWED_COMPONENTS above AND
// this string. They MUST move together.

export const FLOW_SPEC_FOR_PROMPT = `
# WhatsApp Flows JSON specification (v${FLOW_VERSION})

Full reference: https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson

A Flow definition has this top-level shape:

\`\`\`json
{
  "version": "${FLOW_VERSION}",
  "screens": [ { ...screen... }, ... ]
}
\`\`\`

## Screen

\`\`\`json
{
  "id": "SCREEN_ID_IN_SCREAMING_SNAKE",
  "title": "Visible screen title",
  "terminal": true,        // optional; mark true for a final screen
  "success":  true,        // optional; required alongside terminal:true on the screen that completes the flow
  "data":     { ... },     // optional JSON Schema for runtime data passed in
  "layout":   {
    "type": "SingleColumnLayout",   // only allowed layout
    "children": [ ...components... ]
  }
}
\`\`\`

Rules:
- Screen ids must be unique, SCREAMING_SNAKE_CASE, and MUST NOT use the reserved id "SUCCESS".
- Exactly one screen path must reach terminal:true + success:true, otherwise Meta rejects on publish.

## Components (only these types are allowed)

Text / display:
- TextHeading      { "type": "TextHeading",    "text": "..." }
- TextSubheading   { "type": "TextSubheading", "text": "..." }
- TextBody         { "type": "TextBody",       "text": "..." }
- TextCaption      { "type": "TextCaption",    "text": "..." }
- RichText         { "type": "RichText",       "text": "..." }
- Image            { "type": "Image", "src": "<base64>", "alt-text": "..." }

Inputs (all carry a unique \`name\` per screen, used as the field name in the response payload):
- TextInput        { "type": "TextInput", "name": "email", "label": "Your email", "input-type": "email", "required": true }
- TextArea         { "type": "TextArea",  "name": "notes", "label": "Notes" }
- Dropdown         { "type": "Dropdown",  "name": "city",  "label": "City",
                     "data-source": [ { "id": "MUM", "title": "Mumbai" }, { "id": "DEL", "title": "Delhi" } ] }
- RadioButtonsGroup, CheckboxGroup        // same shape as Dropdown
- OptIn            { "type": "OptIn",     "name": "tos",   "label": "I agree to the terms", "required": true }
- DatePicker       { "type": "DatePicker","name": "dob",   "label": "Date of birth" }
- PhotoPicker      { "type": "PhotoPicker","name": "photo","label": "Upload photo", "max-uploaded-photos": 1 }
- DocumentPicker   { "type": "DocumentPicker","name":"doc","label":"Upload document" }

Navigation:
- Footer           { "type": "Footer", "label": "Continue",
                     "on-click-action": { "name": "navigate", "next": { "type": "screen", "name": "NEXT_SCREEN_ID" } } }
- EmbeddedLink     { "type": "EmbeddedLink", "text": "Learn more",
                     "on-click-action": { "name": "open_url", "url": "https://..." } }

## Actions

- navigate         { "name": "navigate", "next": { "type": "screen", "name": "<existing screen id>" }, "payload": {...} }
- complete         { "name": "complete", "payload": { "field": "value", ... } }     // only on Footer of terminal screen
- open_url         { "name": "open_url", "url": "https://..." }
- data_exchange    { "name": "data_exchange", "payload": {...} }                    // server callback (advanced)

## Common rules
- The Footer of a terminal+success screen MUST use the "complete" action — NOT navigate.
- Every navigate target id MUST exist in screens[].id.
- Within a single screen, component \`name\` values must be unique.

## Editing semantics for this builder

When given a natural-language instruction, return the COMPLETE new \`definition\` as JSON (not a patch).
Preserve every existing screen id and component name that wasn't mentioned in the instruction — the user expects
edits to be additive unless they explicitly say "delete" or "replace".
`.trim()
