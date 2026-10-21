# Webhooks

SlipPay POSTs JSON events to your `webhook_url` whenever the state of an
order or subscription changes. Events are signed with HMAC-SHA256 and
retried with exponential backoff until they succeed or are marked dead.

## Event types

| event | when |
|---|---|
| `order.paid` | listener confirmed an on-chain payment matching a one-shot order |
| `order.underpaid` | payment landed but amount below expected |
| `order.expired` | order's expires_at passed without payment (pg_cron) |
| `order.cancelled` | merchant called POST /:id/cancel |
| `subscription.charged` | listener confirmed a payment for an order originating from a subscription |
| `subscription.cancelled` | merchant cancelled the subscription |
| `subscription.expired` | charges_done >= max_periods OR expires_at reached |

> The first time a charge succeeds for a subscription order, the event fires
> as `subscription.charged` (not `order.paid`), so handlers don't need to
> dedup. If you only handle one-shot orders, listen to `order.paid`.

## Payload shape

All events share this envelope:

```json
{
  "type": "order.paid",
  "data": {
    "id": "ord_3f1a8c4d-...",
    "subscription_id": null,
    "external_ref": "cart_42",
    "brl_amount": "99.90",
    "usdc_amount": "18.16",
    "tx_hash": "20655a78f270de139fed0cbc70b37e663253ca2723f957edc27966b56c21ba5c",
    "memo": "ce230c1913a3668164c8544ac49fd244fba452b19ddee02425386945a5e85cd2",
    "paid_at": "2026-05-10T14:00:06Z"
  }
}
```

### Per-event `data` fields

#### `order.paid` / `subscription.charged`

| field | type | notes |
|---|---|---|
| `id` | uuid | the order id |
| `subscription_id` | uuid \| null | populated only on subscription.charged |
| `external_ref` | string \| null | what you set when creating the order/sub |
| `brl_amount` | string | invoice amount |
| `usdc_amount` | string | settlement amount on Stellar |
| `tx_hash` | string | Stellar transaction hash (verifiable on stellar.expert) |
| `memo` | string | 64-hex-char memo that routed the payment |
| `paid_at` | iso8601 | when the listener marked it paid |

#### `order.underpaid`

Same as above plus:

| field | type | notes |
|---|---|---|
| `expected` | string | expected merchant share (after platform fee) |
| `received` | string | actual amount received on-chain |

#### `order.expired` / `order.cancelled`

| field | type |
|---|---|
| `id` | uuid |
| `external_ref` | string \| null |

## Delivery guarantees

- **At-least-once**: an event may be delivered multiple times. Use
  `data.id` (or `data.tx_hash` for paid events) as your idempotency key.
- **Order is not guaranteed**: a `subscription.charged` for cycle 7 may
  arrive before cycle 6 if cycle 6's webhook is still retrying. Use
  `paid_at` to reconstruct order if needed.
- **Body is the source of truth**, not query strings or headers (other than
  the signature).

## Retry schedule

If your endpoint returns anything other than `2xx`, SlipPay retries:

| attempt | delay from previous |
|---|---|
| 1 | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 12 hours |
| 7 | 24 hours |
| 8 | dead — manual replay required |

A single delivery attempt has a **10 second** timeout. Endpoints that take
longer than that should `2xx`-ack first and process the event asynchronously.

A `4xx` response is a permanent client error: the delivery is marked `dead`
immediately and is not retried. A `2xx` is success; everything else (`3xx`,
`5xx`, timeout, or network error) follows the schedule above. Redirects are
never followed.

## SSRF protection

SlipPay refuses to deliver to localhost, RFC1918 private ranges, link-local,
and IPv6 ULA. See `apps/listener/src/ssrf.ts`. If your webhook URL fails
SSRF check, the delivery is marked `dead` immediately and never attempted.

## HMAC verification

Every delivery carries two headers:

```
X-Slippay-Signature: t=1760000000,v1=6fda9c0f8e7b2a1c3d4e5f6789a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8
X-Slippay-Delivery-Id: 0f6b6b9e-5f0e-4a1e-9a5e-3a1f2b3c4d5e
```

- `t` is the Unix timestamp (seconds) used to sign this delivery.
- `v1` is the lowercase hex HMAC-SHA256 of the **canonical string**
  ``${t}.${rawBody}`` using your merchant's `webhook_secret`.
- `X-Slippay-Delivery-Id` is stable across retries. Use it as the idempotency
  key; do not use the signature (it changes when `t` changes).
- Reject a delivery when `abs(now - t) > 300` seconds. This is the replay
  window; a correct signature with an old `t` is still rejected.
- Compare the computed signature with the `v1` value in constant time. If the
  header is malformed, reject it rather than treating it as empty.

### Node / TypeScript

```ts
import crypto from "node:crypto";

const TOLERANCE_S = 300;

export function verify(
  rawBody: Buffer,
  header: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((part) => part.split("=") as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > TOLERANCE_S) return false;
  const expected = `t=${t},v1=${crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody.toString("utf8")}`)
    .digest("hex")}`;
  if (expected.length !== header.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
```

### Python

```python
import hashlib, hmac, time

TOLERANCE_S = 300

def verify(raw: bytes, header: str, secret: str, now: int | None = None) -> bool:
    parts = dict(part.split("=", 1) for part in header.split(",") if "=" in part)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    now = int(time.time()) if now is None else now
    if abs(now - t) > TOLERANCE_S:
        return False
    expected = f"t={t},v1=" + hmac.new(
        secret.encode(), f"{t}.".encode() + raw, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header)
```

### PHP

```php
const TOLERANCE_S = 300;

function verify(string $raw, string $header, string $secret): bool {
    $parts = [];
    foreach (explode(',', $header) as $part) {
        [$key, $value] = array_pad(explode('=', $part, 2), 2, '');
        $parts[$key] = $value;
    }
    if (!isset($parts['t']) || !is_numeric($parts['t'])) return false;
    $t = (int) $parts['t'];
    if (abs(time() - $t) > TOLERANCE_S) return false;
    $expected = 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $raw, $secret);
    return hash_equals($expected, $header);
}
```

> Always read the **raw** body before any framework parsing — JSON
> reserialization changes whitespace and key ordering, breaking HMAC.
> Record the `X-Slippay-Delivery-Id` before acknowledging so a retry is
> deduplicated even if the first response was lost.

## Sample handler (Express)

```ts
import express from "express";
import crypto from "node:crypto";

const app = express();

// CRITICAL: capture raw body for HMAC
app.use("/webhooks/slippay", express.raw({ type: "application/json" }));

app.post("/webhooks/slippay", async (req, res) => {
  const signature = req.header("X-Slippay-Signature") ?? "";
  const deliveryId = req.header("X-Slippay-Delivery-Id") ?? "";
  if (!deliveryId || !verify(req.body, signature, process.env.SLIPPAY_WEBHOOK_SECRET!)) {
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));

  // Idempotency: the delivery id is stable across retries.
  if (await alreadyProcessed(deliveryId)) {
    return res.status(200).send("ok"); // ack the duplicate
  }

  switch (event.type) {
    case "order.paid":
    case "subscription.charged":
      await markOrderPaid(event.data);
      break;
    case "order.underpaid":
      await flagForReview(event.data);
      break;
    // ...
  }

  res.status(200).send("ok");
});
```

## Testing webhooks

For local development, expose your local server with a tunnel:

```sh
# ngrok or cloudflared
ngrok http 3000
# -> https://abc123.ngrok.io
```

Set the resulting URL on your merchant's `webhook_url`. Trigger a payment on
testnet and watch the requests land.

## Replay / debug

Webhook deliveries are stored in the `webhook_deliveries` Postgres table.
The dashboard exposes per-delivery status and the last error message. Manual
replay is on the v0.2 roadmap; for now, trigger another payment to retry.
