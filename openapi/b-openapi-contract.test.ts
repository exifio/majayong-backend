import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const YAML = readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8');

const EXPECTED: readonly (readonly [string, string])[] = [
  ['get', '/projects/{projectId}/applications'],
  ['post', '/projects/{projectId}/applications'],
  ['get', '/me/applications'],
  ['get', '/applications/{applicationId}'],
  ['post', '/applications/{applicationId}/withdraw'],
  ['post', '/applications/{applicationId}/reject'],
  ['post', '/applications/{applicationId}/revisions'],
  ['get', '/me/bookmarks'],
  ['put', '/projects/{projectId}/bookmark'],
  ['delete', '/projects/{projectId}/bookmark'],
  ['get', '/me/recommended-projects'],
  ['get', '/me/chats'],
  ['post', '/applications/{applicationId}/chat/open'],
  ['get', '/applications/{applicationId}/messages'],
  ['post', '/applications/{applicationId}/messages'],
  ['post', '/applications/{applicationId}/messages/read'],
  ['get', '/applications/{applicationId}/agreement-preview'],
  ['post', '/applications/{applicationId}/agreement/confirm'],
  ['get', '/me/contracts'],
  ['get', '/contracts/{contractId}'],
  ['get', '/contracts/{contractId}/document'],
  ['post', '/contracts/{contractId}/sign'],
  ['post', '/contracts/{contractId}/decline'],
  ['post', '/contracts/{contractId}/cancel-provisional'],
  ['get', '/me/notifications'],
  ['patch', '/me/notifications/{notificationId}/read'],
  ['post', '/me/notifications/read-all'],
  ['post', '/messages/{messageId}/reports'],
  ['get', '/me/reports'],
  ['get', '/admin/reports'],
  ['post', '/admin/reports/{reportId}/resolve'],
  ['post', '/support/inquiries'],
  ['get', '/support/inquiries'],
  ['get', '/support/inquiries/{inquiryId}'],
  ['get', '/admin/support/inquiries'],
  ['post', '/admin/support/inquiries/{inquiryId}/answer'],
];

function operations(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let currentPath: string | null = null;
  for (const line of YAML.split('\n')) {
    const pathMatch = /^ {2}(\/\S*):$/.exec(line);
    if (pathMatch !== null) {
      currentPath = pathMatch[1] as string;
      result.set(currentPath, new Set());
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (methodMatch !== null && currentPath !== null) {
      result.get(currentPath)?.add(methodMatch[1] as string);
    }
    if (line.startsWith('components:')) currentPath = null;
  }
  return result;
}

describe('Gate 0 OpenAPI 3.1 계약', () => {
  const declared = operations();

  it('B 담당 36개 operation이 모두 선언되어 있다', () => {
    // 준비
    const total = [...declared.values()].reduce((sum, methods) => sum + methods.size, 0);
    // 확인
    assert.equal(total, 36);
    for (const [method, path] of EXPECTED) {
      const methods = declared.get(path);
      assert.ok(methods !== undefined, `missing path ${path}`);
      assert.ok(methods.has(method), `missing ${method} ${path}`);
    }
  });

  it('공통 봉투·인증·오류 응답이 선언되어 있다', () => {
    // 확인
    assert.match(YAML, /^openapi: 3\.1\.0$/m);
    assert.match(YAML, /^security:\n {2}- bearerAuth: \[\]$/m);
    assert.match(YAML, /^ {4}bearerAuth:/m);
    assert.match(YAML, /^ {4}DataEnvelope:/m);
    assert.match(YAML, /^ {4}ErrorEnvelope:/m);
    for (const response of ['Unauthenticated', 'Forbidden', 'NotFound', 'Conflict', 'InternalError']) {
      assert.match(YAML, new RegExp(`^ {4}${response}:$`, 'm'));
    }
  });

  it('성공 상태 코드가 라우터 동작과 맞는다', () => {
    // 준비
    const created = [
      ['post', '/projects/{projectId}/applications'],
      ['post', '/applications/{applicationId}/revisions'],
      ['put', '/projects/{projectId}/bookmark'],
      ['post', '/applications/{applicationId}/messages'],
      ['post', '/applications/{applicationId}/agreement/confirm'],
      ['post', '/messages/{messageId}/reports'],
      ['post', '/support/inquiries'],
    ] as const;

    // 확인
    for (const [method, path] of created) {
      const block = YAML.slice(YAML.indexOf(`  ${path}:`));
      const nextPath = block.slice(1).search(/\n {2}\/\S*:/);
      const scoped = nextPath < 0 ? block : block.slice(0, nextPath + 1);
      const operation = scoped.slice(scoped.indexOf(`    ${method}:`));
      assert.match(operation, /^ {8}'201':/m, `${method} ${path} should return 201`);
    }
  });
});
