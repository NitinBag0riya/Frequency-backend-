/**
 * Static capability manifest — the LLM's grounding cache, layer 1 (see
 * docs/workflow-builder-interconnect-plan.md §8).
 *
 * Compiles ONE compact description of "everything the product can do" from the
 * existing sources of truth:
 *   - CONNECTOR_REGISTRY  → apps, status, capabilities (+ workflowNodeType)
 *   - PICKER_CATALOG      → the config selections (pickers) + trigger phrases
 *   - node-types.ts       → the node types the executor can actually run
 *
 * The parser injects a tenant-filtered slice of this so it only ever emits real,
 * available nodes and pre-binds obvious selections. Same object also powers a
 * drift report: any registry capability whose workflowNodeType the executor
 * doesn't handle is surfaced here instead of failing live.
 *
 * Layer 2 (per-tenant overlay: connected apps + live resources) is built on top
 * at request time and is intentionally NOT in this file.
 */

import { CONNECTOR_REGISTRY } from '../connectors/registry'
import { PICKER_CATALOG } from '../connectors/picker-catalog'
import { NODE_TYPES, NODE_TYPE_SET, TRIGGER_NODE_TYPES } from './node-types'

export interface ManifestPicker {
  field: string
  label: string
  type: string
  required: boolean
  options?: string[]
  live?: boolean          // true when sourced from a live_endpoint
}

export interface ManifestApp {
  key: string
  name: string
  category: string
  status: string          // live | beta | planned
  /** Workflow actions this app exposes (capability key + the node it maps to). */
  actions: { key: string; label: string; nodeType?: string }[]
}

/** A config-selection group — the "what we ask the user" unit. Mirrors a
 *  PICKER_CATALOG category: its pickers (dropdowns/enums), the intent phrases
 *  that surface it, and an optional operation switch. */
export interface ManifestPickerCategory {
  key: string
  name: string
  blurb: string
  triggerPhrases: string[]
  operations?: { field: string; label: string; choices: { key: string; label: string; requires: string[] }[] }
  pickers: ManifestPicker[]
}

export interface CapabilityManifest {
  /** Stamp set by the caller (Date is avoided in deterministic build contexts). */
  generatedAt: string | null
  nodeTypes: string[]
  triggerNodeTypes: string[]
  apps: ManifestApp[]
  /** The selection inputs we can ask the user for, grouped by capability area. */
  pickerCategories: ManifestPickerCategory[]
  /** Drift: capabilities whose workflowNodeType the executor can't run. */
  drift: { connector: string; capability: string; nodeType: string }[]
}

/** Build the static product manifest. Pure — safe to memoize. */
export function buildStaticManifest(): CapabilityManifest {
  const drift: CapabilityManifest['drift'] = []

  const apps: ManifestApp[] = CONNECTOR_REGISTRY.map(c => ({
    key: c.key,
    name: c.name,
    category: c.category,
    status: c.status,
    actions: (c.capabilities || []).map(cap => {
      if (cap.workflowNodeType && !NODE_TYPE_SET.has(cap.workflowNodeType)) {
        drift.push({ connector: c.key, capability: cap.key, nodeType: cap.workflowNodeType })
      }
      return { key: cap.key, label: cap.label, ...(cap.workflowNodeType ? { nodeType: cap.workflowNodeType } : {}) }
    }),
  }))

  // Selection inputs live in PICKER_CATALOG (its own capability-area taxonomy,
  // not 1:1 with connector keys) — carry them as a first-class section so the
  // parser knows every dropdown/enum + which intent phrases surface it.
  const pickerCategories: ManifestPickerCategory[] = PICKER_CATALOG.map(cat => ({
    key: cat.key,
    name: cat.name,
    blurb: cat.blurb,
    triggerPhrases: cat.trigger_phrases || [],
    ...(cat.operation_picker ? {
      operations: {
        field: cat.operation_picker.field,
        label: cat.operation_picker.label,
        choices: cat.operation_picker.operations.map(o => ({ key: o.key, label: o.label, requires: o.requires })),
      },
    } : {}),
    pickers: (cat.pickers || []).map(p => ({
      field: p.field, label: p.label, type: p.type, required: !!p.required,
      ...(p.options ? { options: p.options } : {}),
      ...(p.live_endpoint ? { live: true } : {}),
    })),
  }))

  return {
    generatedAt: null,
    nodeTypes: [...NODE_TYPES],
    triggerNodeTypes: [...TRIGGER_NODE_TYPES],
    apps,
    pickerCategories,
    drift,
  }
}

// Memoized accessor — the static manifest never changes within a process.
let _cached: CapabilityManifest | null = null
export function getStaticManifest(): CapabilityManifest {
  if (!_cached) _cached = buildStaticManifest()
  return _cached
}
