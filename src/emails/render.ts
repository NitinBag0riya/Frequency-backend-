/**
 * Runtime render layer for React Email templates.
 *
 * `@react-email/render`'s render() is async (v2) and returns the full HTML
 * document. We render the same element twice — once to HTML, once to plain
 * text — so every send site gets a {html,text} pair from one component and we
 * stop hand-maintaining parallel text bodies.
 *
 * Usage at a send site:
 *   const { html, text } = await renderEmail(AgencyMemberInvite, { agencyName, role, acceptUrl })
 *   await sendEmail({ to, subject, html, text, idempotency_key })
 */

import { render } from '@react-email/render'
import { createElement, type ComponentType } from 'react'

export interface RenderedEmail {
  html: string
  text: string
}

export async function renderEmail<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  props: P,
): Promise<RenderedEmail> {
  const el = createElement(Component, props)
  const [html, text] = await Promise.all([
    render(el),
    render(el, { plainText: true }),
  ])
  return { html, text }
}

/** Render a single template to HTML only (used by the auth-template export
 *  script, where the plain-text variant is irrelevant). */
export async function renderEmailHtml<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  props: P,
): Promise<string> {
  return render(createElement(Component, props))
}
