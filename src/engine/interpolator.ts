/**
 * Variable interpolation: replaces {{varName}} in templates with values from
 * the session's variables bag. Missing variables are left as-is so they're
 * obvious in logs (instead of becoming silent empty strings).
 */
export function interpolate(text: string | undefined | null, vars: Record<string, any> = {}): string {
  if (text == null) return ''
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    // Support dotted lookup (e.g. {{contact.name}})
    const parts = key.split('.')
    let val: any = vars
    for (const p of parts) {
      if (val == null) return `{{${key}}}`
      val = val[p]
    }
    if (val == null || val === '') return `{{${key}}}`
    return String(val)
  })
}

/** Recursively interpolate every string in an object/array. Used for body templates,
 *  HTTP request configs, etc. Non-string scalars are returned untouched. */
export function interpolateDeep(value: any, vars: Record<string, any> = {}): any {
  if (value == null) return value
  if (typeof value === 'string') return interpolate(value, vars)
  if (Array.isArray(value)) return value.map(v => interpolateDeep(v, vars))
  if (typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(value)) out[k] = interpolateDeep(value[k], vars)
    return out
  }
  return value
}
