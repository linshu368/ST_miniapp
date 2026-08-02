import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRANT_BODY,
  DEFAULT_GRANT_TITLE,
  MAX_GRANT_AMOUNT,
  describeGrantIssue,
  renderGrantMessage,
} from './outreachCreditsApi';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('grant message rendering', () => {
  it('fills the amount placeholder with the actual grant', () => {
    const rendered = renderGrantMessage({
      title: DEFAULT_GRANT_TITLE,
      body: DEFAULT_GRANT_BODY,
      amount: 500,
    });
    expect(rendered.title).toBe('您的星尘到账了');
    expect(rendered.body).toBe('您的回复奖励 500 星尘已到账');
  });

  it('falls back to the default copy when a field is left blank', () => {
    const rendered = renderGrantMessage({ title: '   ', body: '', amount: 800 });
    expect(rendered.title).toBe(DEFAULT_GRANT_TITLE);
    expect(rendered.body).toBe('您的回复奖励 800 星尘已到账');
  });

  it('sends plain text as written when the placeholder is removed', () => {
    const rendered = renderGrantMessage({
      title: '补偿到账',
      body: '这次给你补了一点星尘，抱歉久等。',
      amount: 500,
    });
    expect(rendered.body).toBe('这次给你补了一点星尘，抱歉久等。');
  });

  it('replaces every placeholder occurrence', () => {
    const rendered = renderGrantMessage({
      title: '到账 {数量}',
      body: '{数量} 星尘已到账，共 {数量}。',
      amount: 120,
    });
    expect(rendered.title).toBe('到账 120');
    expect(rendered.body).toBe('120 星尘已到账，共 120。');
  });
});

describe('grant validation', () => {
  const valid = {
    userId: USER_ID,
    amount: 500,
    title: DEFAULT_GRANT_TITLE,
    body: DEFAULT_GRANT_BODY,
  };

  it('accepts the default form', () => {
    expect(describeGrantIssue(valid)).toBeNull();
  });

  it('requires a confirmed user before granting', () => {
    expect(describeGrantIssue({ ...valid, userId: null })).toBe('请先输入用户 ID 并确认用户信息');
  });

  it('rejects empty, zero, negative and fractional amounts', () => {
    expect(describeGrantIssue({ ...valid, amount: null })).toBe('赠送数量必须是整数');
    expect(describeGrantIssue({ ...valid, amount: 1.5 })).toBe('赠送数量必须是整数');
    expect(describeGrantIssue({ ...valid, amount: 0 })).toContain('赠送数量需在');
    expect(describeGrantIssue({ ...valid, amount: -100 })).toContain('赠送数量需在');
  });

  it('rejects a fat-fingered amount above the hard ceiling', () => {
    expect(describeGrantIssue({ ...valid, amount: MAX_GRANT_AMOUNT + 1 })).toContain(
      '赠送数量需在'
    );
    expect(describeGrantIssue({ ...valid, amount: MAX_GRANT_AMOUNT })).toBeNull();
  });

  it('measures length against the rendered text, not the template', () => {
    expect(describeGrantIssue({ ...valid, title: '标'.repeat(121) })).toBe(
      '推送标题不能超过 120 字'
    );
    expect(describeGrantIssue({ ...valid, body: '正'.repeat(4001) })).toBe(
      '推送正文不能超过 4000 字'
    );
  });
});
