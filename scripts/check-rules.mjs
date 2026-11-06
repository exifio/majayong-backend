#!/usr/bin/env node
/**
 * 의존성 없는 정적 검사. `AGENTS.md`의 금지 패턴 중
 * 기계적으로 판별 가능한 것만 본다. 금액/트랜잭션/권한 규칙은 리뷰 대상이다.
 *
 * - 실패: as any, @ts-ignore, @ts-nocheck
 * - 경고: !!, != null (0/false/'' 의미 보존 검토)
 *
 * 추적 중인 src/tests 파일만 검사해 작업 중인 미추적 파일로 베이스라인이 흔들리지 않게 한다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "src", "tests"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file.endsWith(".ts"));

const HARD = [
  { name: "as any", pattern: /\bas any\b/ },
  { name: "@ts-ignore", pattern: /@ts-ignore/ },
  { name: "@ts-nocheck", pattern: /@ts-nocheck/ },
];
const WARN = [
  { name: "!!", pattern: /!![A-Za-z_(]/ },
  { name: "!= null", pattern: /!= null/ },
];

let hard = 0;
let warnings = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of HARD) {
      if (rule.pattern.test(line)) {
        hard += 1;
        console.error(`FAIL ${file}:${index + 1} ${rule.name}`);
      }
    }
    for (const rule of WARN) {
      if (rule.pattern.test(line)) warnings += 1;
    }
  });
}

console.log(`checked ${files.length} files · hard=${hard} warn=${warnings}`);
process.exitCode = hard === 0 ? 0 : 1;
