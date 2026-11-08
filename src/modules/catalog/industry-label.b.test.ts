import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INDUSTRY_FALLBACK_LABEL, industryLabel } from './industry-label.js';

describe('D-38 업종 라벨', () => {
  it('코드를 화면 라벨로 바꾸고 모르는 코드는 기타로 표시한다', () => {
    assert.equal(industryLabel('FOOD'), '음식점');
    assert.equal(industryLabel('RESTAURANT_RESERVATION'), '예약기반음식점');
    assert.equal(industryLabel('UNKNOWN_CODE'), INDUSTRY_FALLBACK_LABEL);
    assert.equal(industryLabel(null), INDUSTRY_FALLBACK_LABEL);
    assert.equal(industryLabel(''), INDUSTRY_FALLBACK_LABEL);
  });
});
