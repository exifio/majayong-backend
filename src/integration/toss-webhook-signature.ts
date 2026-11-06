import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyTossWebhookSignature(input: {
  securityKey: string;
  rawPayload?: Uint8Array;
  transmissionTime?: string;
  signature?: string;
}): boolean {
  if (
    !/^[0-9a-fA-F]{64}$/.test(input.securityKey) ||
    input.rawPayload === undefined ||
    typeof input.transmissionTime !== "string" ||
    input.transmissionTime.length === 0 ||
    typeof input.signature !== "string"
  ) {
    return false;
  }

  const expected = createHmac("sha256", Buffer.from(input.securityKey, "hex"))
    .update(input.rawPayload)
    .update(":", "utf8")
    .update(input.transmissionTime, "utf8")
    .digest();

  for (const candidate of input.signature.split(",")) {
    const match = /^v1:([A-Za-z0-9+/]{43}=)$/.exec(candidate.trim());
    if (!match) continue;
    const received = Buffer.from(match[1], "base64");
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}
