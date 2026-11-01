import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LineChart } from './line-chart.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LineChart', () => {
  it('renders each y-axis tick once when the maximum is 1 (no duplicate keys)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(
      <LineChart
        title="Matches per minute"
        points={[
          { label: '10:00', value: 0 },
          { label: '10:01', value: 1 },
        ]}
      />,
    );

    const ticks = [...container.querySelectorAll('svg > g:has(> line) > text')].map(
      (node) => node.textContent,
    );
    expect(ticks).toEqual(['0', '1']);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
