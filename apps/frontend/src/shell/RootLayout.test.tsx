import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import App from '../App';
import { disconnectShared, useShellStore } from '../features/platform';
import * as clustersApi from '../features/infrastructure/api/clusters';
import * as deploymentsApi from '../features/infrastructure/api/deployments';
import * as credentialsApi from '../features/infrastructure/api/credentials';
import * as authApi from '../features/platform/api';
import * as identityApi from '../features/instances/api/identity';
import * as instancesApi from '../features/instances/api/instances';
import { replacedLocation } from '../test/location';
import { signedInShell } from '../test/signed-in';

vi.mock('../features/infrastructure/api/clusters', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof clustersApi>, 'listClusters'));
vi.mock('../features/infrastructure/api/deployments', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof deploymentsApi>, 'listDeployments'));
vi.mock('../features/infrastructure/api/credentials', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof credentialsApi>, 'listProviders'));
vi.mock('../features/platform/api', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof authApi>, 'getMe', 'logout', 'signInPlace'));
vi.mock('../features/instances/api/identity', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof identityApi>, 'getMyInstance'));
vi.mock('../features/instances/api/instances', async (importOriginal) => ({
  ...(await importOriginal<typeof instancesApi>()),
  useMySetup: vi.fn(() => ({ data: null, isPending: false })),
}));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
};

describe('where a signed-in person lands', () => {
  beforeEach(signedInShell);

  it('root\'s page never reads clusters, deployments or cloud providers', async () => {
    vi.mocked(identityApi.getMyInstance).mockResolvedValue({ instance: null, servesTenants: false });
    show();
    expect((await screen.findAllByRole('button', { name: /Sign out/ })).length).toBeGreaterThan(0);
    expect(screen.queryByText('Infrastructure')).toBeNull();
    expect(clustersApi.listClusters).not.toHaveBeenCalled();
    expect(deploymentsApi.listDeployments).not.toHaveBeenCalled();
    expect(credentialsApi.listProviders).not.toHaveBeenCalled();
  });

  it('fetches what it shows again when its connection comes back, since it heard nothing while away', async () => {
    const connected: Array<() => void> = [];
    const socket = { connected: false, connect: vi.fn(), on: vi.fn((event: string, listener: () => void) => { if (event === 'connect') connected.push(listener); }), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn(), off: vi.fn() } };
    disconnectShared();
    vi.mocked(io).mockReturnValueOnce(socket as never);
    vi.mocked(identityApi.getMyInstance).mockResolvedValue({ instance: null, servesTenants: false });
    show();
    expect((await screen.findAllByRole('button', { name: /Sign out/ })).length).toBeGreaterThan(0);
    for (const listener of connected) listener();
    await waitFor(() => expect(socket.connect).toHaveBeenCalled());
    const asked = vi.mocked(identityApi.getMyInstance).mock.calls.length;
    for (const listener of connected) listener();
    await waitFor(() => expect(vi.mocked(identityApi.getMyInstance).mock.calls.length).toBeGreaterThan(asked));
  });

  it('a missing identity route is an error shown, not "no instance", and reads nothing of a tenant', async () => {
    vi.mocked(identityApi.getMyInstance).mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'Cannot GET /api/identity/instance' } } }));
    show();
    expect(await screen.findByText(/Koala could not tell whether this server holds your work/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot GET \/api\/identity\/instance/)).toBeInTheDocument();
    expect(screen.queryByText('Infrastructure')).toBeNull();
    expect(clustersApi.listClusters).not.toHaveBeenCalled();
  });
});

describe('where a signed-out person goes', () => {
  const START = '/api/auth/oidc/start';
  const stood = replacedLocation();
  const { assign } = stood;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.getMe).mockResolvedValue(null);
    useShellStore.getState().setUser(null);
    useShellStore.getState().setAuthLoading(true);
    vi.mocked(authApi.signInPlace).mockResolvedValue({ url: START, providers: [] });
    stood.install();
  });

  afterEach(() => {
    stood.restore();
  });

  it('goes to the sign-in place when no sign-in is waiting for it', async () => {
    window.history.replaceState({}, '', '/');
    show();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START));
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it('shows the sign-in form for the sign-in root is resuming, and goes nowhere by itself', async () => {
    window.history.replaceState({}, '', `/?resume=${encodeURIComponent('/oidc/interaction/u1')}`);
    show();
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('never shows the form for a resume that is not root\'s sign-in, and goes to the sign-in place instead', async () => {
    window.history.replaceState({}, '', `/?resume=${encodeURIComponent('https://elsewhere.example/oidc/interaction/u1')}`);
    show();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START));
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it('says where sign-in could not be found rather than showing a form with nowhere to go', async () => {
    vi.mocked(authApi.signInPlace).mockRejectedValue(new Error('Request failed with status code 502'));
    window.history.replaceState({}, '', `/?resume=${encodeURIComponent('/oidc/interaction/u1')}`);
    show();
    expect(await screen.findByText(/Koala could not find where to sign in: Request failed with status code 502/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });
});

describe('signing out of a Koala', () => {
  const END = 'http://root.example/oidc/session/end?id_token_hint=t';
  const stood = replacedLocation();
  const { assign } = stood;

  beforeEach(() => {
    signedInShell();
    vi.mocked(identityApi.getMyInstance).mockResolvedValue({ instance: null, servesTenants: true });
    vi.mocked(authApi.signInPlace).mockResolvedValue({ url: '/api/auth/oidc/start', providers: [] });
    vi.mocked(authApi.logout).mockResolvedValue(END);
    useShellStore.getState().setUser(null);
    useShellStore.getState().setAuthLoading(true);
    window.history.replaceState({}, '', '/');
    stood.install();
  });

  afterEach(() => {
    stood.restore();
  });

  it('goes only to root to end the sign-in there, closing its live connection, and never starts a new sign-in on the way', async () => {
    const socket = { connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn(), off: vi.fn() } };
    disconnectShared();
    vi.mocked(io).mockReturnValue(socket as never);
    show();
    (await screen.findByRole('button', { name: 'Log Out' })).click();
    expect(await screen.findByText('Signing you out of Koala…')).toBeInTheDocument();
    expect(assign.mock.calls).toEqual([[END]]);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(authApi.signInPlace).not.toHaveBeenCalled();
  });
});
