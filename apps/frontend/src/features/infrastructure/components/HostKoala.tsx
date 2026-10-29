import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Server, XCircle } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { safeHref } from '../../../shared/lib/safe-href'
import { useCan } from '../../platform'
import { Section } from '../../monitoring'
import { getVpsCatalog, vpsKeys, type VpsOffer } from '../api/vps-catalog'
import { FOLLOWED, revealSetupCode, revealSshKey, type ServerOrder } from '../api/server-orders'
import { useBuyServer, useCancelServerOrder, useDnsProviders, useQuoteServer, useServerOrder, useServerOrders, useZoneChecks } from '../hooks/useServerOrders'
import { useDebounce } from '../../../shared/lib/use-debounce'
import type { ZoneView } from '../api/server-orders'
import { QuietButton } from './Parts'

const field = 'w-full rounded-md border border-[var(--bark-600)] bg-[var(--bark-900)] px-2.5 py-1.5 text-[12px] text-slate-100'
const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`

export function QuoteCard({ order, onBought }: { order: ServerOrder; onBought: (order: ServerOrder) => void }) {
  const [accepted, setAccepted] = useState(false)
  const buy = useBuyServer()
  const cancel = useCancelServerOrder()
  const { quote } = order
  return (
    <div className="space-y-3 rounded-md border border-amber-700/60 bg-amber-950/20 p-4" data-testid="server-quote">
      <div className="text-[13px] font-semibold text-slate-100">{order.planLabel} in {order.datacenter}, from OVHcloud ({order.subsidiary})</div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-4">
        <div><dt className="text-slate-500">Each month</dt><dd className="text-slate-100">{money(quote.monthly, quote.currency)}</dd></div>
        <div><dt className="text-slate-500">Setup</dt><dd className="text-slate-100">{money(quote.setupFee, quote.currency)}</dd></div>
        <div><dt className="text-slate-500">Tax</dt><dd className="text-slate-100">{money(quote.tax, quote.currency)}</dd></div>
        <div><dt className="text-slate-500">Charged now</dt><dd className="font-semibold text-amber-200">{money(quote.withTax, quote.currency)}</dd></div>
      </dl>
      <ul className="space-y-0.5 text-[11px] text-slate-400">
        {quote.lines.map((line, index) => <li key={index}>{line.description}: {money(line.amount, quote.currency)}</li>)}
      </ul>
      {quote.contracts.length > 0 && (
        <div className="space-y-1 text-[11px]">
          <div className="text-slate-400">Buying accepts OVHcloud's contracts:</div>
          <ul className="space-y-0.5">
            {quote.contracts.map((contract) => (
              <li key={contract.url}><a href={safeHref(contract.url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-300 hover:underline">{contract.name} <ExternalLink size={10} /></a></li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-slate-400">
        It is charged to the payment method on your OVHcloud account and renews each month until you terminate it in OVHcloud's control panel.
        Koala then installs Ubuntu 24.04 with its own SSH key, points app.{order.domain}, mesh.{order.domain} and *.{order.ingressDomain} at it, and installs root.
      </p>
      <label className="flex items-center gap-2 text-[12px] text-slate-200">
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="accent-amber-500" />
        I accept these contracts and want to pay {money(quote.withTax, quote.currency)} now
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!accepted || buy.isPending}
          onClick={() => buy.mutate({ id: order.id, total: quote.withTax }, { onSuccess: onBought })}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {buy.isPending ? 'Buying…' : `Buy for ${money(quote.withTax, quote.currency)}`}
        </button>
        <QuietButton onClick={() => cancel.mutate(order.id)} disabled={cancel.isPending || buy.isPending}>Cancel</QuietButton>
        {buy.isError && <span className="text-[12px] text-rose-300">{errorMessage(buy.error)}</span>}
        {cancel.isError && <span className="text-[12px] text-rose-300">{errorMessage(cancel.error)}</span>}
      </div>
    </div>
  )
}

function Reveal({ label, load }: { label: string; load: () => Promise<string> }) {
  const [shown, setShown] = useState<string>()
  const [problem, setProblem] = useState<string>()
  if (shown) return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bark-950)] p-2 text-[11px] text-emerald-200">{shown}</pre>
  return (
    <span className="inline-flex items-center gap-2">
      <QuietButton onClick={() => { load().then(setShown, (error: unknown) => setProblem(errorMessage(error))) }}><KeyRound size={11} /> {label}</QuietButton>
      {problem && <span className="text-[11px] text-rose-300">{problem}</span>}
    </span>
  )
}

export function OrderDetail({ id }: { id: string }) {
  const order = useServerOrder(id)
  const cancel = useCancelServerOrder()
  if (order.isPending) return <div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading the order…</div>
  if (order.isError) return <p className="text-[12px] text-rose-300">{errorMessage(order.error)}</p>
  const current = order.data
  const following = FOLLOWED.includes(current.state)
  return (
    <div className="space-y-3 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-4" data-testid="server-order">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {current.state === 'ready' ? <CheckCircle2 size={14} className="text-emerald-300" /> : current.state === 'failed' ? <XCircle size={14} className="text-rose-300" /> : following ? <Loader2 size={14} className="animate-spin text-blue-300" /> : <Server size={14} className="text-slate-400" />}
        <span className="font-semibold text-slate-100">{current.planLabel} · {current.domain}</span>
        {current.orderId !== undefined && <span className="text-[11px] text-slate-500">OVHcloud order {current.orderId}</span>}
        {current.ip && <span className="text-[11px] text-slate-500">{current.ip}</span>}
      </div>
      <p className="text-[12px] text-slate-300">{current.said}</p>
      <div className="flex flex-wrap items-center gap-2">
        {current.state === 'ready' && (
          <a href={safeHref(`https://app.${current.domain}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-emerald-600">Open root <ExternalLink size={11} /></a>
        )}
        {current.hasSetupCode && <Reveal label="Show the setup code (once)" load={() => revealSetupCode(current.id)} />}
        {current.hasSshKey && <Reveal label="Show the server's SSH key" load={() => revealSshKey(current.id).then((key) => `root@${key.host ?? current.ip ?? ''}\n\n${key.privateKey}`)} />}
        {following && <QuietButton danger onClick={() => cancel.mutate(current.id)} disabled={cancel.isPending}>Stop following</QuietButton>}
      </div>
      {current.hasSetupCode && <p className="text-[11px] text-slate-500">Sign up at root with the setup code in the invite field; that account becomes root's operator.</p>}
      {(current.log ?? []).length > 0 && (
        <pre className="max-h-96 overflow-auto rounded bg-[var(--bark-950)] p-2 text-[11px] leading-snug text-slate-300" data-testid="server-order-log">{(current.log ?? []).join('\n')}</pre>
      )}
    </div>
  )
}

export function ZoneLine({ zone, override, onOverride, providers }: {
  zone: ZoneView
  override: string
  onOverride: (provider: string) => void
  providers: readonly { name: string; label: string }[]
}) {
  const chosen = override || zone.provider
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`zone-${zone.zone}`}>
      <span className="font-mono text-slate-300">{zone.zone}</span>
      {zone.provider
        ? <span className={zone.credentials ? 'text-emerald-300' : 'text-amber-300'}>{zone.label}{zone.credentials ? ', credentials stored' : `, no credentials stored. ${zone.setup ?? ''}`}</span>
        : <span className="text-amber-300">{zone.problem}</span>}
      <select aria-label={`DNS provider for ${zone.zone}`} className="rounded border border-[var(--bark-600)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[11px] text-slate-200" value={override} onChange={(event) => onOverride(event.target.value)}>
        <option value="">{zone.provider ? `As its nameservers say (${zone.label})` : 'Pick its DNS provider'}</option>
        {providers.map((provider) => <option key={provider.name} value={provider.name}>{provider.label}</option>)}
      </select>
      {!chosen && <span className="text-slate-500">Koala needs to know who serves this zone's DNS.</span>}
    </div>
  )
}

export function HostKoala() {
  const can = useCan()
  const orders = useServerOrders()
  const plans = useQuery({ queryKey: vpsKeys.catalog('provider=ovh&sort=price'), queryFn: () => getVpsCatalog('provider=ovh&sort=price') })
  const quote = useQuoteServer()
  const [planId, setPlanId] = useState('')
  const [datacenter, setDatacenter] = useState('')
  const [domain, setDomain] = useState('')
  const [ingressDomain, setIngressDomain] = useState('')
  const [acmeEmail, setAcmeEmail] = useState('')
  const [opened, setOpened] = useState<string>()
  const [domainDns, setDomainDns] = useState('')
  const [ingressDns, setIngressDns] = useState('')
  const zones = useZoneChecks(useDebounce([domain, ingressDomain].filter(Boolean), 500))
  const dnsProviders = useDnsProviders()

  const offers = useMemo(() => (plans.data?.offers ?? []).filter((offer) => offer.provider === 'ovh'), [plans.data])
  const plan: VpsOffer | undefined = offers.find((offer) => offer.id === planId)
  const quoted = (orders.data ?? []).find((order) => order.state === 'quoted')

  if (!can('administer')) return <p className="p-6 text-[12px] text-slate-400">Only the operator of this server can buy one for Koala's root.</p>

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="host-koala">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100"><Server size={17} className="text-[var(--leaf)]" /> Host Koala on a server</h1>
        <p className="text-[12px] text-slate-400">
          Buy an OVHcloud VPS and make it Koala's root: the server people sign in through, with its own domain and the domain people's instances live under.
          You need your OVHcloud keys under Cloud providers, credentials for the DNS provider of each domain (Koala finds which from their nameservers), and a payment method on your OVHcloud account.
          Nothing is bought until you confirm the price OVHcloud gives.
        </p>

        {quoted ? <QuoteCard order={quoted} onBought={(order) => setOpened(order.id)} /> : (
          <Section title="Price a server">
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!plan) return
                quote.mutate({ planCode: plan.planId, planLabel: plan.label, datacenter, domain, ingressDomain, acmeEmail, ...(domainDns ? { domainDns } : {}), ...(ingressDns ? { ingressDns } : {}) })
              }}
            >
              <label className="space-y-1 text-[11px] text-slate-400">Plan
                <select id="host-koala-plan" className={field} value={planId} onChange={(event) => { setPlanId(event.target.value); setDatacenter('') }}>
                  <option value="">{plans.isPending ? 'Reading OVHcloud\'s prices…' : 'Pick a plan'}</option>
                  {offers.map((offer) => <option key={offer.id} value={offer.id}>{offer.label} · {offer.vcpu} vCPU · {offer.ramGb} GB · {offer.diskGb} GB · {money(offer.priceMonthly, offer.currency)}/mo</option>)}
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-400">Datacenter
                <select id="host-koala-datacenter" className={field} value={datacenter} onChange={(event) => setDatacenter(event.target.value)} disabled={!plan}>
                  <option value="">Pick a datacenter</option>
                  {(plan?.locations ?? []).map((location) => <option key={location} value={location}>{location}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-[11px] text-slate-400">Root's domain (app. and mesh. go under it)
                <input id="host-koala-domain" className={field} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="nowrinkles.dev" />
              </label>
              <label className="space-y-1 text-[11px] text-slate-400">People's domain (a different registered domain)
                <input id="host-koala-ingress" className={field} value={ingressDomain} onChange={(event) => setIngressDomain(event.target.value)} placeholder="nowrinkles.app" />
              </label>
              {(zones.data ?? []).length > 0 && (
                <div className="space-y-1 sm:col-span-2">
                  {(zones.data ?? []).map((zone) => (
                    <ZoneLine key={zone.zone} zone={zone} providers={dnsProviders.data ?? []}
                      override={zone.zone === domain.trim().toLowerCase() ? domainDns : ingressDns}
                      onOverride={zone.zone === domain.trim().toLowerCase() ? setDomainDns : setIngressDns} />
                  ))}
                </div>
              )}
              <label className="space-y-1 text-[11px] text-slate-400 sm:col-span-2">Email for certificates and root's mail
                <input id="host-koala-email" type="email" className={field} value={acmeEmail} onChange={(event) => setAcmeEmail(event.target.value)} placeholder="you@example.com" />
              </label>
              <div className="flex items-center gap-3 sm:col-span-2">
                <button type="submit" disabled={!plan || !datacenter || !domain || !ingressDomain || !acmeEmail || quote.isPending} className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                  {quote.isPending ? 'Asking OVHcloud for the price…' : 'Price it'}
                </button>
                {quote.isError && <span className="text-[12px] text-rose-300">{errorMessage(quote.error)}</span>}
              </div>
            </form>
          </Section>
        )}

        <Section title="Servers bought for root">
          {orders.isPending ? <p className="text-[12px] text-slate-400">Reading…</p>
            : orders.isError ? <p className="text-[12px] text-rose-300">{errorMessage(orders.error)}</p>
            : (orders.data ?? []).filter((order) => order.state !== 'quoted').length === 0 ? <p className="text-[12px] text-slate-500">None yet.</p>
            : (
              <ul className="space-y-1.5">
                {(orders.data ?? []).filter((order) => order.state !== 'quoted').map((order) => (
                  <li key={order.id}>
                    <button type="button" onClick={() => setOpened(order.id)} className={`w-full rounded-md border px-3 py-2 text-left text-[12px] ${opened === order.id ? 'border-blue-600' : 'border-[var(--bark-700)]'} bg-[var(--bark-900)]/40 hover:bg-[var(--bark-800)]`}>
                      <span className="font-semibold text-slate-100">{order.planLabel} · {order.domain}</span> <span className="text-slate-400">{order.said}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Section>

        {opened && <OrderDetail id={opened} />}
      </div>
    </div>
  )
}

export default HostKoala
