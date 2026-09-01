import { describe, expect, it } from 'vitest';
import { normalizeInviteCode } from './invite.js';

/**
 * 邀请码入参收窄的回归测试。
 *
 * 起因：阶段三 UAT（invite-uat 的 attribution_invalid_code 场景）打出这个缺口——
 * 请求体里 invite_code 是数字时，原实现的 (body.invite_code ?? '').trim() 抛
 * TypeError 变成 500。非法输入必须走 invalid_code 终态，不能是服务端错误。
 */
describe('normalizeInviteCode', () => {
  it('合法 8 位码原样通过，首尾空格被 trim', () => {
    expect(normalizeInviteCode('ABCD1234')).toBe('ABCD1234');
    expect(normalizeInviteCode('  ABCD1234  ')).toBe('ABCD1234');
  });

  it('大小写不在这一层归一（由 RPC 的 upper() 负责），但要放行', () => {
    expect(normalizeInviteCode('abcd1234')).toBe('abcd1234');
  });

  it.each([
    ['过短', 'ABC'],
    ['过长', 'ABCDEFGHI'],
    ['含连字符', 'ABCD-123'],
    ['空串', ''],
    ['纯空格', '    '],
    ['SQL 注入样本', "' OR 1=1--"],
    ['含中文', '邀请码ABCD'],
  ])('非法字符串 %s 返回 null', (_label, value) => {
    expect(normalizeInviteCode(value)).toBeNull();
  });

  it.each([
    ['数字', 12345678],
    ['null', null],
    ['undefined', undefined],
    ['对象', { code: 'ABCD1234' }],
    ['数组', ['ABCD1234']],
    ['布尔', true],
  ])('非字符串 %s 返回 null 而不抛异常', (_label, value) => {
    expect(() => normalizeInviteCode(value)).not.toThrow();
    expect(normalizeInviteCode(value)).toBeNull();
  });
});
