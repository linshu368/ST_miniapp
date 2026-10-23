import { describe, expect, it } from 'vitest';

import { toRouteTemplate } from './route-template';

describe('toRouteTemplate', () => {
  it('replaces uuids and numeric ids so metric dimensions stay low-cardinality', () => {
    expect(toRouteTemplate('/api/characters/a5ea7a8d-9a4a-462f-af64-d304173b24c5')).toBe(
      '/api/characters/:id'
    );
    expect(toRouteTemplate('/api/profile/recharge/12345')).toBe('/api/profile/recharge/:id');
  });

  it('drops the query string and fragment', () => {
    expect(toRouteTemplate('/api/lobby-characters?sort=latest&token=secret#x')).toBe(
      '/api/lobby-characters'
    );
  });

  it('keeps ordinary literal segments', () => {
    expect(toRouteTemplate('/api/v1/conversations/latest-badge')).toBe(
      '/api/v1/conversations/latest-badge'
    );
  });
});
