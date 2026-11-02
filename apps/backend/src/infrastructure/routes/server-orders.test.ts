import type { RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ServerOrderView } from '../services/ServerOrderService.js';
import { ServerOrderProblem, type QuoteAsk, type ServerOrderService } from '../services/ServerOrderService.js';
import { serverOrdersRouter } from './server-orders.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const open: RequestHandler = (_req, _res, next) => next();
const closed: RequestHandler = (_req, res) => { res.status(403).json({ error: 'only the operator' }); };

const ASK = { planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' };
const order = (extra: object = {}): ServerOrderView => ({ id: 'o1', state: 'quoted', sshPrivateKey: 'PRIVATE', setupCode: 'CODE', signInEnv: 'v2:sealed', ...extra }) as unknown as ServerOrderView;

const call = (serverOrders: ServerOrderService, path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, operatorOnly: RequestHandler = open) =>
  routesInProcess({ prefix: '/api/server-orders', router: () => serverOrdersRouter({ serverOrders, operatorOnly }), user: PERSON })
    .then((routes) => routes.request(method, `/api/server-orders${path}`, body !== undefined ? { body } : {}));

describe('/api/server-orders', () => {
  it('is the operator\'s alone', async () => {
    const serverOrders = mock<ServerOrderService>();
    expect((await call(serverOrders, '', 'GET', undefined, closed)).status).toBe(403);
    expect((await call(serverOrders, '/quote', 'POST', ASK, closed)).status).toBe(403);
    expect(serverOrders.quote).not.toHaveBeenCalled();
  });

  it('lists the person\'s orders without a secret in them', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.list.calledWith(PERSON.id).mockResolvedValue([order()]);
    const answer = await call(serverOrders, '');
    expect(answer.data).toEqual([{ id: 'o1', state: 'quoted' }]);
  });

  it('prices a plan from the ask and answers 201 with the order, reading no domain DNS provider that was left blank', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.quote.calledWith(PERSON.id, matches<QuoteAsk>((ask) => ask.planCode === 'vps-2027-model2' && ask.domainDns === undefined && ask.ingressDns === 'porkbun' && ask.acmeEmail === 'me@example.com')).mockResolvedValue(order());
    const answer = await call(serverOrders, '/quote', 'POST', { ...ASK, ingressDns: 'porkbun' });
    expect(answer.status).toBe(201);
    expect(answer.data).toEqual({ id: 'o1', state: 'quoted' });
  });

  it('answers a refused quote with the status and words the service gave', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.quote.mockRejectedValue(new ServerOrderProblem(400, 'Add your OVHcloud keys under Cloud providers first'));
    const answer = await call(serverOrders, '/quote', 'POST', ASK);
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'Add your OVHcloud keys under Cloud providers first' });
  });

  it('answers 502 with the reason when OVHcloud itself fails', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.quote.mockRejectedValue(new Error('OVHcloud answered 500'));
    const answer = await call(serverOrders, '/quote', 'POST', ASK);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'OVHcloud answered 500' });
  });

  it('says who serves each zone\'s DNS, refusing a request naming none or three', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.zones.calledWith(PERSON.id, matches<readonly string[]>((zones) => zones.join() === 'a.test,b.test')).mockResolvedValue([{ zone: 'a.test', nameservers: [], credentials: false }, { zone: 'b.test', nameservers: [], credentials: false }]);
    expect((await call(serverOrders, '/zones?zone=a.test&zone=b.test')).status).toBe(200);
    expect((await call(serverOrders, '/zones')).status).toBe(400);
    expect((await call(serverOrders, '/zones?zone=a.test&zone=b.test&zone=c.test')).data).toEqual({ error: 'Name one or two zones as ?zone=' });
  });

  it('describes the sign-in providers root can be given, for the domain when one is typed', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.signInProviders.calledWith('nowrinkles.dev').mockReturnValue([{ id: 'google' }] as never);
    serverOrders.signInProviders.calledWith(undefined).mockReturnValue([]);
    expect((await call(serverOrders, '/sign-in-providers?domain=nowrinkles.dev')).data).toEqual([{ id: 'google' }]);
    expect((await call(serverOrders, '/sign-in-providers')).data).toEqual([]);
  });

  it('shows one order, and says when there is none', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.get.calledWith(PERSON.id, 'o1').mockResolvedValue(order());
    serverOrders.get.calledWith(PERSON.id, 'nope').mockRejectedValue(new ServerOrderProblem(404, 'No such server order'));
    expect((await call(serverOrders, '/o1')).data).toEqual({ id: 'o1', state: 'quoted' });
    expect((await call(serverOrders, '/nope')).status).toBe(404);
  });

  it('buys at the total the person confirmed and hands the service nothing else', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.buy.calledWith(PERSON.id, 'o1', 15.4).mockResolvedValue(order({ state: 'bought' }));
    serverOrders.buy.calledWith(PERSON.id, 'o1', 1).mockRejectedValue(new ServerOrderProblem(409, 'You confirmed 1 AUD'));
    expect((await call(serverOrders, '/o1/buy', 'POST', { confirmedTotal: 15.4 })).data).toEqual({ id: 'o1', state: 'bought' });
    expect((await call(serverOrders, '/o1/buy', 'POST', { confirmedTotal: 1 })).status).toBe(409);
  });

  it('cancels an order', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.cancel.calledWith(PERSON.id, 'o1').mockResolvedValue(order({ state: 'quote-cancelled' }));
    expect((await call(serverOrders, '/o1', 'DELETE')).data).toEqual({ id: 'o1', state: 'quote-cancelled' });
  });

  it('answers the setup code and the SSH key uncached, and only when there is one', async () => {
    const serverOrders = mock<ServerOrderService>();
    serverOrders.setupCode.calledWith(PERSON.id, 'o1').mockResolvedValue('0123');
    serverOrders.sshKey.calledWith(PERSON.id, 'o1').mockResolvedValue({ privateKey: 'KEY', host: '203.0.113.7' });
    serverOrders.setupCode.calledWith(PERSON.id, 'o2').mockRejectedValue(new ServerOrderProblem(404, 'not given a setup code'));
    const code = await call(serverOrders, '/o1/setup-code', 'POST');
    expect(code.data).toEqual({ setupCode: '0123' });
    expect(code.headers['cache-control']).toBe('no-store');
    expect((await call(serverOrders, '/o1/ssh-key', 'POST')).data).toEqual({ privateKey: 'KEY', host: '203.0.113.7' });
    const none = await call(serverOrders, '/o2/setup-code', 'POST');
    expect(none.status).toBe(404);
    expect(none.headers['cache-control']).toBe('no-store');
  });
});
