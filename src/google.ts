/**
 * Google API helpers — Sheets and Calendar actions for workflow nodes.
 * All calls use the tenant's stored OAuth tokens and auto-refresh when expired.
 */

import { createClient } from '@supabase/supabase-js'
// B5: encrypt/decrypt now live in src/crypto.ts (AES-256-GCM with v1 prefix
// + legacy CBC fallback). The wrappers below preserve the old (text:string)
// signature this module exports — callers just keep importing { encrypt,
// decrypt } from './google' and get GCM under the hood for free.
import { encrypt as cryptoEncrypt, decrypt as cryptoDecrypt } from './crypto'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!

if (process.env.GOOGLE_TOKEN_SECRET && process.env.GOOGLE_TOKEN_SECRET.length < 16) {
  console.warn('[google] GOOGLE_TOKEN_SECRET is shorter than 16 chars — recommended >= 32 hex')
}

export function encrypt(text: string): string {
  // Preserve legacy "" / undefined-passthrough behaviour at this call surface.
  // crypto.ts's encrypt returns null for empty input; old callers expect a
  // string — fall back to the input itself so DB inserts of "" stay "".
  if (!text) return text
  return cryptoEncrypt(text) ?? text
}

export function decrypt(text: string): string {
  if (!text) return text
  return cryptoDecrypt(text)
}

// ── Token refresh ─────────────────────────────────────────────────────────────
/**
 * Returns a non-expired Google access token for the given tenant row, doing
 * a refresh round-trip + DB writeback if the stored one is within 60s of
 * expiry. Exported so REST capability handlers in index.ts can hit Google
 * APIs directly (e.g. freebusy.query, sheets.values.get with full envelope)
 * without re-implementing OAuth refresh.
 */
export async function getValidGoogleToken(tenant: any): Promise<string> {
  return getValidToken(tenant)
}

async function getValidToken(tenant: any): Promise<string> {
  const expiry = tenant.google_token_expiry ? new Date(tenant.google_token_expiry) : null
  const accessToken = decrypt(tenant.google_access_token)
  const refreshToken = decrypt(tenant.google_refresh_token)

  if (expiry && expiry > new Date(Date.now() + 60_000)) {
    return accessToken
  }

  // Refresh
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Google token refresh failed: ${data.error_description ?? data.error}`)

  const newExpiry = new Date(Date.now() + data.expires_in * 1_000).toISOString()
  await supabase.from('tenants').update({
    google_access_token: encrypt(data.access_token),
    google_token_expiry: newExpiry,
    updated_at: new Date().toISOString(),
  }).eq('id', tenant.id)

  return data.access_token
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

/** Append a row to a Google Sheet */
export async function sheetsAppendRow(tenant: any, spreadsheetId: string, range: string, values: string[]) {
  const token = await getValidToken(tenant)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Sheets append failed: ${data.error.message}`)
  return data
}

/** Update a specific cell range in a Google Sheet */
export async function sheetsUpdateRange(tenant: any, spreadsheetId: string, range: string, values: string[][]) {
  const token = await getValidToken(tenant)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Sheets update failed: ${data.error.message}`)
  return data
}

/** Read values from a range */
export async function sheetsReadRange(tenant: any, spreadsheetId: string, range: string): Promise<string[][]> {
  const token = await getValidToken(tenant)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as any
  if (data.error) throw new Error(`Sheets read failed: ${data.error.message}`)
  return data.values ?? []
}

/** Get spreadsheet metadata (including sheet names) */
export async function sheetsGetMetadata(tenant: any, spreadsheetId: string) {
  const token = await getValidToken(tenant)
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?includeGridData=false`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as any
  if (data.error) throw new Error(`Sheets metadata failed: ${data.error.message}`)
  return data
}

/** List Google Sheets files from Drive */
export async function listSpreadsheets(tenant: any) {
  const token = await getValidToken(tenant)
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'")
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json() as any
  if (data.error) throw new Error(`Drive list failed: ${data.error.message}`)
  return data.files ?? []
}

// ── Google Calendar ───────────────────────────────────────────────────────────

export interface CalendarEvent {
  summary: string
  description?: string
  location?: string
  startTime: string  // ISO 8601
  endTime: string    // ISO 8601
  timeZone?: string
  attendeeEmails?: string[]
}

/** Create a Calendar event */
export async function calendarCreateEvent(tenant: any, calendarId: string = 'primary', event: CalendarEvent) {
  const token = await getValidToken(tenant)
  const payload: any = {
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startTime, timeZone: event.timeZone ?? 'Asia/Kolkata' },
    end:   { dateTime: event.endTime,   timeZone: event.timeZone ?? 'Asia/Kolkata' },
  }
  if (event.attendeeEmails?.length) {
    payload.attendees = event.attendeeEmails.map(email => ({ email }))
  }

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Calendar create failed: ${data.error.message}`)
  return data
}

/** Check if a time slot is free (returns true if available) */
export async function calendarCheckAvailability(
  tenant: any,
  calendarId: string = 'primary',
  startTime: string,
  endTime: string
): Promise<boolean> {
  const token = await getValidToken(tenant)
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: startTime,
      timeMax: endTime,
      items: [{ id: calendarId }]
    })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Calendar freebusy failed: ${data.error.message}`)
  const busy: any[] = data.calendars?.[calendarId]?.busy ?? []
  return busy.length === 0
}

/** List upcoming events */
export async function calendarListEvents(tenant: any, calendarId: string = 'primary', maxResults: number = 10) {
  const token = await getValidToken(tenant)
  const now = new Date().toISOString()
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${now}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json() as any
  if (data.error) throw new Error(`Calendar list failed: ${data.error.message}`)
  return data.items ?? []
}

// ── Gmail ────────────────────────────────────────────────────────────────────

/** Send an email via Gmail API */
export async function gmailSendEmail(tenant: any, to: string, subject: string, body: string) {
  const token = await getValidToken(tenant)
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
  const messageParts = [
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    body,
  ]
  const message = messageParts.join('\n')
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encodedMessage })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Gmail send failed: ${data.error.message}`)
  return data
}

/**
 * List new INBOX messages since the tenant's last poll.
 *
 * Two paths:
 *   - Have a prior `gmail_history_id`: use users.history.list to get only
 *     the deltas since that point (cheap, accurate).
 *   - First-ever poll (no history_id stored): fall back to users.messages.list
 *     with `q=newer_than:5m -from:me category:primary` so we don't replay
 *     hours of inbox on first connect. Seeds history_id from the newest
 *     message in the result so the next tick uses the cheap delta path.
 *
 * Returns parsed envelope info (id, from, fromName, subject, snippet,
 * historyId) for each new message — enough for keyword matching and for
 * logging to the messages table. Body parts beyond snippet are not
 * fetched (keeps the polling cycle fast); workflows that need full body
 * can call gmail.messages.get via http_request.
 */
export interface GmailNewThread {
  id:         string
  historyId?: string
  from:       string                // email address only (parsed from header)
  fromName?:  string                // display name if present
  subject?:   string
  snippet?:   string                // Gmail's pre-extracted preview text
}

export async function gmailListNewThreads(tenant: any): Promise<GmailNewThread[]> {
  const token = await getValidToken(tenant)

  let messageIds: string[] = []
  let nextHistoryId: string | undefined

  if (tenant.gmail_history_id) {
    // Delta path — much cheaper. Returns only changes since startHistoryId.
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${tenant.gmail_history_id}&historyTypes=messageAdded&labelId=INBOX`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json() as any
    if (body.error) {
      // 404 = history_id too old (Gmail purges after ~7 days). Reset to
      // bootstrap path on the next tick by clearing the column.
      if (body.error.code === 404) return []
      throw new Error(`Gmail history.list failed: ${body.error.message}`)
    }
    nextHistoryId = body.historyId
    for (const h of (body.history ?? [])) {
      for (const ma of (h.messagesAdded ?? [])) {
        if (ma.message?.id) messageIds.push(ma.message.id)
      }
    }
  } else {
    // Bootstrap path — last 5 minutes only, primary category, exclude self.
    // Caps overall first-tick volume at ~50 messages so a chatty tenant
    // doesn't fire a workflow blast on Frequency adoption day.
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('newer_than:5m -from:me category:primary')}&maxResults=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const body = await r.json() as any
    if (body.error) throw new Error(`Gmail messages.list failed: ${body.error.message}`)
    messageIds = (body.messages ?? []).map((m: any) => m.id).filter(Boolean)
  }

  if (messageIds.length === 0) {
    return nextHistoryId ? [{ id: '', historyId: nextHistoryId } as any].slice(0, 0) : []
  }

  // Hydrate each message with envelope info (From, Subject, snippet).
  // metadataHeaders limits the payload — much faster than full format.
  const out: GmailNewThread[] = []
  for (const id of messageIds.slice(0, 50)) {  // safety cap per tick
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const m = await r.json() as any
    if (m.error) {
      console.warn(`[gmail] hydrate ${id} failed: ${m.error.message}`)
      continue
    }
    const headers: Array<{ name: string; value: string }> = m.payload?.headers ?? []
    const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
    const subjectHeader = headers.find(h => h.name?.toLowerCase() === 'subject')?.value ?? ''
    // Parse "Name <addr>" or just "addr"
    const fromMatch = /<([^>]+)>/.exec(fromHeader)
    const from = (fromMatch ? fromMatch[1] : fromHeader).trim()
    const fromName = fromMatch ? fromHeader.slice(0, fromMatch.index).trim().replace(/^"|"$/g, '') : undefined
    out.push({
      id:        m.id,
      historyId: m.historyId ?? nextHistoryId,
      from,
      fromName,
      subject:   subjectHeader,
      snippet:   m.snippet,
    })
  }
  // Set historyId on the LAST message so the worker can persist it.
  if (out.length > 0 && nextHistoryId) {
    out[out.length - 1].historyId = nextHistoryId
  }
  return out
}
