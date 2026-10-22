import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import KoalaLoading from './KoalaLoading';

describe('KoalaLoading', () => {
  it('announces itself to a screen reader rather than only animating', () => {
    render(<KoalaLoading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('says what is being waited on', () => {
    render(<KoalaLoading label="Fetching this conversation…" />);
    expect(screen.getByText('Fetching this conversation…')).toBeInTheDocument();
  });

  it('bobs rather than sways — the 6s foliage sway does not read as loading', () => {
    const { container } = render(<KoalaLoading />);
    expect(container.querySelector('.koala-bob')).toBeInTheDocument();
  });
});
