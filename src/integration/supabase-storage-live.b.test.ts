import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createSupabaseStorageAdapter } from "./supabase-storage.ts";

// 실제 Supabase 비공개 버킷 검증. 키가 없으면 skip한다(운영 데이터 업로드 금지, 테스트 객체만 사용).
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET;
const hasSupabase = Boolean(url && serviceRoleKey && bucket);

describe("INT-D11: Supabase 서명 URL 실검증", { skip: hasSupabase ? false : "SUPABASE_* 없음" }, () => {
  it("서명 업로드 → 다운로드 → 삭제가 동작한다", async () => {
    // 준비
    const adapter = createSupabaseStorageAdapter({ url: url as string, serviceRoleKey: serviceRoleKey as string });
    const objectKey = `d11-signed-url-${randomUUID()}.txt`;
    try {
      // 실행
      const upload = await adapter.createUploadUrl(bucket as string, objectKey, 300);
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "d11-ok",
      });
      // 확인
      assert.equal(put.ok, true, `업로드 실패: ${put.status}`);

      const download = await adapter.createDownloadUrl(bucket as string, objectKey, 180);
      const get = await fetch(download.downloadUrl);
      assert.equal(get.ok, true, `다운로드 실패: ${get.status}`);
      assert.equal(await get.text(), "d11-ok");
      assert.equal(download.expiresInSec, 180);
    } finally {
      const base = (url as string).replace(/\/+$/, "");
      await fetch(`${base}/storage/v1/object/${bucket}/${objectKey}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey as string,
        },
      });
    }
  });
});
