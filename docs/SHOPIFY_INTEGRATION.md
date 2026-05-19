# Shopify integration (P1 #11)

## What lives where

- Migration: `supabase/migrations/078_shopify.sql` — three tables (`shopify_stores`, `shopify_order_events`, `shopify_abandoned_checkouts`).
- OAuth start + callback: `src/routes/shopify-oauth.ts`.
- Webhook receiver: `src/routes/shopify-webhook.ts` + raw-body capture in `src/index.ts`.
- Tenant-facing API (list / disconnect / fulfill / recent orders): `src/routes/shopify.ts`.
- Workflow trigger fan-out: `src/engine/shopify-triggers.ts`.
- Abandoned-cart poller (BullMQ singleton, every 5 min): `src/workers/shopify-abandoned-cart-poller.ts` (registered in `src/worker.ts`).
- Registry entries (six triggers + one action under the `shopify` connector): `src/connectors/registry.ts`.

## Shopify Partner app setup

1. Create a Partner account at <https://partners.shopify.com>.
2. Apps → Create app → Public app.
3. App URL: `https://<your-frequency-host>/api/shopify/install`.
4. Allowed redirect URLs: `https://<your-frequency-host>/api/shopify/callback`.
5. Scopes: `read_orders, write_orders, read_customers, read_checkouts, read_fulfillments`.
6. From the app's API credentials page copy the API key and API secret key.

## Required env vars (server)

```
SHOPIFY_API_KEY=<from Partner dashboard>
SHOPIFY_API_SECRET=<from Partner dashboard>
SHOPIFY_APP_URL=https://<your-frequency-host>
```

If any of these is unset, `/api/shopify/install` returns a 503 (`Shopify integration not configured`) and `/api/shopify/callback` 503s the same way. Webhook deliveries to a misconfigured server will fail HMAC verify and be dropped.

## Flow

1. Tenant visits the Apps page, clicks "Connect Shopify", enters their shop domain (e.g. `acme-store.myshopify.com`).
2. FE opens `/api/shopify/install?shop=<>` in a new tab, which 302s to Shopify's authorize URL with a signed `state` blob (10-min TTL).
3. Merchant approves, Shopify calls `/api/shopify/callback` with `code`, `shop`, `hmac`, `state`. We verify Shopify's HMAC + our own state HMAC, exchange the code for an access token, encrypt it (`src/lib/crypto.ts` → AES-256-GCM), insert the `shopify_stores` row with a fresh per-install `webhook_secret`, and register the seven webhooks.
4. Every Shopify webhook delivery hits `/api/webhooks/shopify`. We HMAC-verify with the per-store secret, dedupe via `unique(store_id, shopify_order_id, topic)`, fan out to live workflows that subscribed to the matching trigger node type, and **always return 200**.
5. Abandoned-cart poller picks up checkouts older than 10 min that haven't been recovered or nudged, and fires the `shopify_abandoned_cart` trigger.

## Workflow triggers / actions

Authors pick these from the chat-driven workflow builder (NO visual canvas — the builder reads the registry):

- `shopify_order_created` / `shopify_order_paid` / `shopify_order_cancelled` / `shopify_order_fulfilled`
- `shopify_abandoned_cart`
- `shopify_cod_order`
- `shopify_fulfill_order` (action — calls Shopify Admin API)

## Submission status

Shopify Partner app submission is NOT part of this change. Until the app is approved, tenants must install it as a development store using the "Install" button in the Partner dashboard.
