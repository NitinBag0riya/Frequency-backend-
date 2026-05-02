/**
 * Google API helpers — Sheets and Calendar actions for workflow nodes.
 * All calls use the tenant's stored OAuth tokens and auto-refresh when expired.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!

// ── Token refresh ─────────────────────────────────────────────────────────────
async function getValidToken(tenant: any): Promise<string> {
  const expiry = tenant.google_token_expiry ? new Date(tenant.google_token_expiry) : null
  if (expiry && expiry > new Date(Date.now() + 60_000)) {
    return tenant.google_access_token
  }

  // Refresh
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tenant.google_refresh_token,
      grant_type: 'refresh_token',
    })
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`Google token refresh failed: ${data.error_description ?? data.error}`)

  const newExpiry = new Date(Date.now() + data.expires_in * 1_000).toISOString()
  await supabase.from('tenants').update({
    google_access_token: data.access_token,
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
