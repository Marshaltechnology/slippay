import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Merchant-facing webhook and checkout docs (#350)", () => {
  const root = path.resolve(__dirname, "../../..");
  const webhooks = fs.readFileSync(
    path.join(root, "docs/api-reference/webhooks.md"),
    "utf8",
  );
  const orders = fs.readFileSync(path.join(root, "docs/api-reference/orders.md"), "utf8");

  it("documents the signed-timestamp header and canonical string", () => {
    expect(webhooks).toContain("X-Slippay-Signature");
    expect(webhooks).toContain("`t` is the Unix timestamp");
    expect(webhooks).toContain("v1=");
    expect(webhooks).toContain("${t}.${rawBody}");
    expect(webhooks).toContain("abs(now - t) > 300");
  });

  it("documents the delivery id and retry/dedup contract", () => {
    expect(webhooks).toContain("X-Slippay-Delivery-Id");
    expect(webhooks).toContain("idempotency");
    expect(webhooks).toContain("10 second");
    expect(webhooks).toContain("`4xx`");
    expect(webhooks).toContain("marked `dead`");
  });

  it("documents the public checkout token model", () => {
    expect(orders).toContain("?t=<checkout-token>");
    expect(orders).toContain("base64url(HMAC-SHA256");
    expect(orders).toContain("order's `expires_at`");
    expect(orders).toContain("401 unauthorized");
    expect(orders).toContain("verifyCheckoutToken");
  });
});
