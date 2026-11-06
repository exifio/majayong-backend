import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ROUTE_PATHS } from "./c-app.ts";

// A/B는 router.METHOD("path")로 등록하고, C는 ROUTE_PATHS에 (method, path)를 모아 둔다.
const ROUTE_FILES = [
  "src/app.ts",
  "src/modules/profile/api.ts",
  "src/modules/draft/api.ts",
  "src/modules/pricing/api.ts",
  "src/modules/project/api.ts",
  "src/modules/application/http.ts",
  "src/modules/market/http.ts",
  "src/modules/chat/http.ts",
  "src/modules/contract/http.ts",
  "src/modules/notification/http.ts",
  "src/modules/report/http.ts",
  "src/modules/support/http.ts",
];

// 원본 118 인벤토리 밖에서 승인된 추가(D-11 파일 다운로드, D-25 Toss 예치 승인).
const APPROVED_ADDITIONS = new Set([
  "GET /uploads/:param/download",
  "POST /contracts/:param/deposits/:param/confirm",
]);

const normalize = (operation: string): string => {
  const [method] = operation.split(" ");
  const path = operation.slice(method!.length + 1);
  return `${method} ${path.replace(/\{[^}]+\}/g, ":param").replace(/:[A-Za-z0-9_]+/g, ":param")}`;
};

function documentOperations(): string[] {
  const source = readFileSync("openapi/API_INDEX.md", "utf8");
  return [...source.matchAll(/^\|\s*\d{3}\s*\|[^|]*\|[^|]*\|\s*`([A-Z]+)`\s*\|\s*`([^`]+)`\s*\|$/gm)]
    .map((match) => `${match[1]} ${match[2]}`);
}

function codeOperations(): string[] {
  const operations: string[] = [];
  for (const file of ROUTE_FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
      operations.push(`${match[1]!.toUpperCase()} ${match[2]}`);
    }
  }
  operations.push(...ROUTE_PATHS);
  return operations;
}

describe("API 인벤토리: 118 operation 단일 mount", () => {
  it("원본 인벤토리는 118 method+path / 102 고유 경로이고 중복이 없다", () => {
    // 준비
    const operations = documentOperations();

    // 확인
    assert.equal(operations.length, 118);
    assert.equal(new Set(operations).size, 118);
    assert.equal(new Set(operations.map((operation) => operation.split(" ").slice(1).join(" "))).size, 102);
  });

  it("Express 라우트에 같은 method+path가 두 번 등록되지 않는다", () => {
    // 준비
    const normalized = codeOperations().map(normalize);
    const duplicates = normalized.filter((value, index) => normalized.indexOf(value) !== index);

    // 확인
    assert.deepEqual([...new Set(duplicates)], []);
  });

  it("원본 118 operation이 모두 실제 라우트로 존재하고, 추가는 승인된 2건뿐이다", () => {
    // 준비
    const document = new Set(documentOperations().map(normalize));
    const code = new Set(codeOperations().map(normalize));

    // 확인
    assert.deepEqual([...document].filter((operation) => !code.has(operation)), []);
    assert.deepEqual(
      [...code].filter((operation) => !document.has(operation)).sort(),
      [...APPROVED_ADDITIONS].sort(),
    );
  });
});
