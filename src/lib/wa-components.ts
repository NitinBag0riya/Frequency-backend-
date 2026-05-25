/**
 * WhatsApp Cloud API `components` ↔ flat-columns translation.
 *
 * Meta represents a template as an array:
 *   [{type:'HEADER', format:'TEXT'|'IMAGE'|'VIDEO'|'DOCUMENT', text?, example?},
 *    {type:'BODY',   text:'...', example?},
 *    {type:'FOOTER', text:'...'},
 *    {type:'BUTTONS', buttons:[{type:'QUICK_REPLY'|'URL'|'PHONE_NUMBER'|'COPY_CODE',
 *                               text:'...', url?, phone_number?, example?}]}]
 *
 * Our `wa_templates` table stores the same content in flat columns
 * (body, header jsonb, footer text, buttons jsonb). This module keeps
 * the translation in ONE place — used by:
 *   • workers/template-sync.ts  — Meta → DB
 *   • routes /api/wa-templates  — DB ↔ FE (GET) + FE → Meta (POST/CREATE)
 *
 * Preserves all button metadata (url, phone_number, copy_code, example)
 * so a round-trip (DB → resubmit to Meta) doesn't drop fields and
 * trigger Meta validation errors.
 */

export interface ParsedComponents {
  body:    string | null
  header:  { text?: string; type: string; format?: string } | null
  footer:  string | null
  buttons: Array<Record<string, any>>
}

/** Meta `components` array → our flat columns. */
export function parseComponents(components: any[] | undefined | null): ParsedComponents {
  const empty: ParsedComponents = { body: null, header: null, footer: null, buttons: [] }
  if (!Array.isArray(components)) return empty

  const find = (type: string) => components.find(c => String(c?.type ?? '').toUpperCase() === type)
  const headerComp  = find('HEADER')
  const bodyComp    = find('BODY')
  const footerComp  = find('FOOTER')
  const buttonsComp = find('BUTTONS')

  // Header — text headers carry .text; media headers carry format
  // (IMAGE/VIDEO/DOCUMENT) and a .example.header_handle URL we keep
  // for round-trip resubmits but don't surface in previews.
  let header: ParsedComponents['header'] = null
  if (headerComp) {
    const fmt = String(headerComp.format ?? 'TEXT').toLowerCase()
    if (headerComp.text || fmt !== 'text') {
      header = {
        type:   fmt,
        format: fmt,
        ...(headerComp.text ? { text: String(headerComp.text) } : {}),
        ...(headerComp.example ? { example: headerComp.example } : {}),
      }
    }
  }

  // Buttons — preserve type-specific fields rather than collapsing to
  // {text, type}. QUICK_REPLY has text only; URL has url + optional
  // example (for dynamic suffixes); PHONE_NUMBER has phone_number;
  // COPY_CODE has the copy_code value.
  const buttons: Array<Record<string, any>> = Array.isArray(buttonsComp?.buttons)
    ? buttonsComp.buttons
        .filter((b: any) => b?.text)
        .map((b: any) => {
          const out: Record<string, any> = {
            type: String(b.type ?? 'QUICK_REPLY'),
            text: String(b.text),
          }
          if (b.url)          out.url          = String(b.url)
          if (b.phone_number) out.phone_number = String(b.phone_number)
          if (b.copy_code)    out.copy_code    = String(b.copy_code)
          if (b.example)      out.example      = b.example
          return out
        })
    : []

  return {
    body:    bodyComp?.text ?? null,
    header,
    footer:  footerComp?.text ?? null,
    buttons,
  }
}

/** Our flat columns → Meta `components` array. Inverse of parseComponents.
 *  Used by POST /api/wa-templates (re-submit after edit) and any place
 *  that needs to send a stored template back through Meta's API. */
export function buildComponents(parsed: Partial<ParsedComponents>): any[] {
  const out: any[] = []
  if (parsed.header) {
    const h = parsed.header
    const fmt = String(h.format ?? h.type ?? 'text').toUpperCase()
    const comp: any = { type: 'HEADER', format: fmt }
    if (h.text) comp.text = h.text
    if ((h as any).example) comp.example = (h as any).example
    out.push(comp)
  }
  if (parsed.body) out.push({ type: 'BODY', text: parsed.body })
  if (parsed.footer) out.push({ type: 'FOOTER', text: parsed.footer })
  if (parsed.buttons && parsed.buttons.length > 0) {
    out.push({
      type: 'BUTTONS',
      buttons: parsed.buttons.map(b => {
        const out2: any = { type: String(b.type ?? 'QUICK_REPLY'), text: String(b.text ?? '') }
        if (b.url)          out2.url          = b.url
        if (b.phone_number) out2.phone_number = b.phone_number
        if (b.copy_code)    out2.copy_code    = b.copy_code
        if (b.example)      out2.example      = b.example
        return out2
      }),
    })
  }
  return out
}
