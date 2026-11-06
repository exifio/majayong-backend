import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { verifyTossWebhookSignature } from "./toss-webhook-signature.ts";

const SECURITY_KEY = "0123456789abcdef".repeat(4);
const TRANSMISSION_TIME = "2026-11-06T10:15:30+09:00";

function sign(rawPayload: Buffer, transmissionTime: string): string {
  return createHmac("sha256", Buffer.from(SECURITY_KEY, "hex"))
    .update(rawPayload)
    .update(":", "utf8")
    .update(transmissionTime, "utf8")
    .digest("base64");
}

describe("Toss 웹훅 서명 검증", () => {
  it("원문과 전송 시각이 일치하는 여러 v1 서명 중 하나를 허용한다", () => {
    const rawPayload = Buffer.from('{\n  "eventType" : "PAYMENT_STATUS_CHANGED", "data": {"status":"DONE"}\n}', "utf8");
    const validSignature = sign(rawPayload, TRANSMISSION_TIME);
    const invalidSignature = Buffer.alloc(32).toString("base64");

    assert.equal(
      verifyTossWebhookSignature({
        securityKey: SECURITY_KEY,
        rawPayload,
        transmissionTime: TRANSMISSION_TIME,
        signature: `v1:${invalidSignature},v1:${validSignature}`,
      }),
      true,
    );
  });

  it("본문이나 전송 시각이 달라지면 서명을 거부한다", () => {
    const rawPayload = Buffer.from('{"eventType":"PAYMENT_STATUS_CHANGED"}', "utf8");
    const signature = `v1:${sign(rawPayload, TRANSMISSION_TIME)}`;

    assert.equal(
      verifyTossWebhookSignature({
        securityKey: SECURITY_KEY,
        rawPayload: Buffer.from('{"eventType":"PAYMENT_STATUS_CHANGED","extra":true}', "utf8"),
        transmissionTime: TRANSMISSION_TIME,
        signature,
      }),
      false,
    );
    assert.equal(
      verifyTossWebhookSignature({
        securityKey: SECURITY_KEY,
        rawPayload,
        transmissionTime: "2026-11-06T10:15:31+09:00",
        signature,
      }),
      false,
    );
  });

  it("보안 키와 서명 형식이 올바르지 않으면 거부한다", () => {
    assert.equal(
      verifyTossWebhookSignature({
        securityKey: "x".repeat(64),
        rawPayload: Buffer.from("{}"),
        transmissionTime: TRANSMISSION_TIME,
        signature: `v1:${sign(Buffer.from("{}"), TRANSMISSION_TIME)}`,
      }),
      false,
    );
    assert.equal(
      verifyTossWebhookSignature({
        securityKey: SECURITY_KEY,
        rawPayload: Buffer.from("{}"),
        transmissionTime: TRANSMISSION_TIME,
        signature: "v2:unknown",
      }),
      false,
    );
  });
});
