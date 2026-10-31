import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ServerOrder } from '../api/server-orders'
import { ServerOrderMail } from './ServerOrderMail'

const order = (extra: Partial<ServerOrder>): ServerOrder => ({
  id: 'o1', provider: 'ovh', purpose: 'root', subsidiary: 'US', planCode: 'p', planLabel: 'VPS', datacenter: 'US-EAST-VA', domain: 'nowrinkles.dev',
  ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com', dns: { domain: 'cloudflare', ingress: 'porkbun' },
  quote: { currency: 'USD', withoutTax: 1, tax: 0, withTax: 1, monthly: 1, setupFee: 0, lines: [], contracts: [] },
  quotedAt: 'x', state: 'ready', said: 'Root is running', hasSetupCode: false, hasSshKey: false, createdAt: 'x', updatedAt: 'x', ...extra,
} as ServerOrder)

describe('root\'s mail on its order', () => {
  it('shows nothing before root has a reverse DNS or a mail check', () => {
    const { container } = render(<ServerOrderMail order={order({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the reverse DNS and every line of root\'s own mail check, and what is left to fix', () => {
    render(<ServerOrderMail order={order({
      reverseDns: { ip: '203.0.113.7', name: 'mail.nowrinkles.dev', state: 'set', said: 'OVHcloud set the reverse DNS of 203.0.113.7 to mail.nowrinkles.dev', at: 'x' },
      mail: {
        check: { domain: 'nowrinkles.dev', host: 'mail.nowrinkles.dev', ip: '203.0.113.7', checkedAt: '2026-10-30T00:00:00.000Z' },
        lines: [
          { mark: 'ok', said: '203.0.113.7 reverses to mail.nowrinkles.dev' },
          { mark: 'problem', said: '203.0.113.7 is on UCEPROTECT level 1 (127.0.0.2)' },
          { mark: 'unknown', said: 'Spamhaus ZEN could not be asked: the list refuses queries that come through a public resolver' },
        ],
        problems: ['203.0.113.7 is on UCEPROTECT level 1 (127.0.0.2)'],
      },
    })} />)
    expect(screen.getByTestId('server-order-reverse-dns')).toHaveTextContent('Reverse DNS: OVHcloud set the reverse DNS of 203.0.113.7 to mail.nowrinkles.dev')
    expect(screen.getByLabelText('to fix').closest('li')).toHaveTextContent('UCEPROTECT level 1')
    expect(screen.getByLabelText('could not be checked').closest('li')).toHaveTextContent('Spamhaus ZEN')
    expect(screen.getByText(/1 thing to fix before root's mail is relied on/)).toBeInTheDocument()
  })

  it('says when OVHcloud refused, so the operator sets it by hand', () => {
    render(<ServerOrderMail order={order({ reverseDns: { ip: '203.0.113.7', name: 'mail.nowrinkles.dev', state: 'refused', said: 'the reverse DNS of 203.0.113.7 is not set: OVHcloud answered 403; set the reverse DNS (PTR) of 203.0.113.7 to mail.nowrinkles.dev in OVHcloud\'s control panel', at: 'x' } })} />)
    expect(screen.getByTestId('server-order-reverse-dns')).toHaveTextContent(/set the reverse DNS \(PTR\) of 203\.0\.113\.7 to mail\.nowrinkles\.dev in OVHcloud's control panel/)
  })
})
