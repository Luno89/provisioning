import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import NginxView from '../components/NginxView';

const mutation = (over: Record<string, unknown> = {}) => ({
  isPending: false, isSuccess: false, isError: false, error: null,
  mutate: vi.fn(), ...over,
}) as any;

const setup = (over: Record<string, unknown> = {}) => {
  const props = {
    editorContent: 'server { listen 80; }',
    setEditorContent: vi.fn(),
    loadingNginxConfig: false,
    updateNginxConfig: mutation(),
    deployments: [{ id: 'd1', name: 'weather', status: 'running' }],
    clusters: [{ id: 'c1', name: 'local' }],
    vpnDomains: {} as Record<string, string>,
    setVpnDomains: vi.fn(),
    onAddRoute: vi.fn(),
    ...over,
  };
  render(<NginxView {...(props as any)} />);
  return props;
};

describe('the screen renders at all', () => {
  it('shows its heading and the current config', () => {
    setup();
    expect(screen.getByText('Nginx Router Settings')).toBeInTheDocument();
    expect(screen.getByDisplayValue('server { listen 80; }')).toBeInTheDocument();
  });

  it('renders with no deployments and no clusters', () => {
    expect(() => setup({ deployments: [], clusters: [] })).not.toThrow();
    expect(screen.getByText('Nginx Router Settings')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends the editor content', () => {
    const props = setup();
    fireEvent.click(screen.getByText(/Save/i));
    expect(props.updateNginxConfig.mutate).toHaveBeenCalledWith('server { listen 80; }');
  });

  it('disables the button while a save is in flight', () => {
    setup({ updateNginxConfig: mutation({ isPending: true }) });
    expect(screen.getByText(/Save/i).closest('button')).toBeDisabled();
  });

  it('disables it while the config is still loading', () => {
    setup({ loadingNginxConfig: true });
    expect(screen.getByText(/Save/i).closest('button')).toBeDisabled();
  });
});

describe('the proxy wizard', () => {
  it('asks to open the wizard, and nothing more', () => {
    const props = setup();
    fireEvent.click(screen.getByText(/Proxy Wizard/i));
    expect(props.onAddRoute).toHaveBeenCalled();
  });
});
