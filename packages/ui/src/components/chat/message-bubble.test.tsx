import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MessageBubble } from './message-bubble.tsx';

afterEach(() => {
  cleanup();
});

describe('MessageBubble', () => {
  it('renders HTML in messages as literal text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
    const { container } = render(<MessageBubble from="stranger" text={hostile} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
  });

  it('does not turn URLs into links', () => {
    const { container } = render(
      <MessageBubble from="stranger" text="visit https://evil.example/login now" />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('labels the sender for screen readers and offers retry on failure', () => {
    let retried = false;
    render(
      <MessageBubble
        from="self"
        text="hi"
        status="failed"
        onRetry={() => {
          retried = true;
        }}
      />,
    );
    expect(screen.getByText('You:')).toBeTruthy();
    screen.getByRole('button', { name: /retry/i }).click();
    expect(retried).toBe(true);
  });
});
