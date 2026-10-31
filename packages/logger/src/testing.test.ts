import { describe, expect, it } from 'vitest';

import { createCapturingLogger, findSecrets } from './testing.ts';

describe('log-privacy helpers', () => {
  it('captures every line and reports secrets by label only', () => {
    const logs = createCapturingLogger('svc');
    logs.logger.trace({ visitorId: 'v1' }, 'hello 203.0.113.9');
    expect(logs.lines).toHaveLength(1);
    expect(findSecrets(logs.text(), { ip: '203.0.113.9', device: 'dev-1' })).toEqual(['ip']);
  });

  it('flags JWT-shaped strings even when the exact token is unknown', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2MSJ9.c2lnbmF0dXJlLXZhbHVl';
    expect(findSecrets(`token ${jwt}`, {})).toEqual(['jwt-shaped string']);
    expect(findSecrets('nothing here', { empty: '' })).toEqual([]);
  });
});
