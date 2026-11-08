import { afterAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { FilePurpose, InquiryCategory, PrismaClient, Role } from "@prisma/client";
import { cleanupE2e } from "../tests/e2e-cleanup.ts";

// A DB 삭제 helper는 전용 테스트 DB에서만 실행한다.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E cleanup tests require dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("E2E 정리 helper", () => {
  it("초안 발화·문의 첨부를 남기지 않고 사용자를 지운다", async () => {
    // 준비: 사용자·초안·발화·문의·첨부
    const userId = randomUUID();
    const draftId = randomUUID();
    const inquiryId = randomUUID();
    await prisma.user.create({ data: { id: userId, email: `cleanup-${userId}@example.invalid`, role: Role.CLIENT } });
    await prisma.draft.create({ data: { id: draftId, clientId: userId, entryType: "SENTENCE" } });
    await prisma.clientUtterance.create({ data: { draftId, kind: "FIRST_SENTENCE", content: "정리 대상 발화" } });
    await prisma.supportInquiry.create({
      data: { id: inquiryId, userId, category: InquiryCategory.OTHER, title: "정리 대상 문의", body: "본문" },
    });
    await prisma.fileAttachment.create({
      data: {
        purpose: FilePurpose.SUPPORT_INQUIRY,
        inquiryId,
        uploaderId: userId,
        objectKey: `cleanup/${randomUUID()}`,
        fileName: "proof.pdf",
        fileSize: 1024,
        mimeType: "application/pdf",
      },
    });

    // 실행: helper로 같은 사용자·초안 정리
    await cleanupE2e(prisma, { userIds: [userId], draftIds: [draftId] });

    // 확인: 발화·첨부·문의·초안·사용자가 모두 사라진다
    expect(await prisma.clientUtterance.count({ where: { draftId } })).toBe(0);
    expect(await prisma.fileAttachment.count({ where: { uploaderId: userId } })).toBe(0);
    expect(await prisma.supportInquiry.count({ where: { id: inquiryId } })).toBe(0);
    expect(await prisma.draft.count({ where: { id: draftId } })).toBe(0);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
  });
});
