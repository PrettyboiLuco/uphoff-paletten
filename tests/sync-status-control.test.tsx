import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';

describe('sync status control', () => {
  it('renders an accessible retry button instead of inert status text', () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toMatch(/<button[^>]*aria-label="Synchronisierung prüfen"[^>]*>/);
  });
});
