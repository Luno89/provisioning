import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import NginxView from './NginxView';

type Props = ComponentProps<typeof NginxView>;

const mutation = (over: Partial<Props['updateNginxConfig']> = {}): Props['updateNginxConfig'] => ({
  isPending: false, isSuccess: false, isError: false, error: null,
  mutate: vi.fn(), ...over,
});

const setup = (over: Partial<Props> = {}) => {
  const props: Props = {
    editorContent: 'server { listen 80; }',
    setEditorContent: vi.fn(),
    loadingNginxConfig: false,
    updateNginxConfig: mutation(),
    deployments: [{ id: 'd1', name: 'weather', appType: 'wordpress', clusterId: 'c1', status: 'running' }],
    clusters: [{ id: 'c1', name: 'local' }],
    vpnDomains: {},
    setVpnDomains: vi.fn(),
    onAddRoute: vi.fn(),
    ...over,
  };
  render(<NginxView {...props} />);
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
