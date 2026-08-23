/**
 * What each provider is called, what it costs you to connect, and which fields its form needs.
 *
 * ── WHY THIS IS NOT IN CloudAccounts.tsx ──
 * It was, and it was 180 of that file's 867 lines — static metadata sitting in the middle of a
 * component, which is what made `CloudAccounts.tsx` export three non-components and trip
 * `react-refresh/only-export-components` three times. That rule is not pedantry: a module that
 * mixes a component with other exports cannot be hot-reloaded reliably, so every edit here used to
 * cost a full page refresh.
 *
 * kebab-case filename because it exports no component — see the naming rule in CLAUDE.md.
 */
interface ProviderMeta {
  key: string;
  label: string;
  color: string;
  icon: string;
  docsUrl: string;
  fields: { key: string; label: string; sensitive: boolean; placeholder: string; multiline?: boolean }[];
}

// Exported so tests can assert against the real list instead of a hardcoded count that silently
// goes stale (and fails) every time a provider is added.
export const PROVIDERS: ProviderMeta[] = [
  {
    key: 'huggingface',
    label: 'Hugging Face',
    color: '#FFD21E',
    icon: '🤗',
    docsUrl: 'https://huggingface.co/settings/tokens',
    fields: [
      { key: 'hfToken', label: 'Access Token (HF_TOKEN)', sensitive: true, placeholder: 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'defaultModel', label: 'Default Model (Optional)', sensitive: false, placeholder: 'meta-llama/Llama-3.2-3B-Instruct' },
    ],
  },
  {
    key: 'github',
    label: 'GitHub',
    color: '#2DA44E',
    icon: '🐙',
    docsUrl: 'https://github.com/settings/tokens',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'username', label: 'GitHub Username (Optional)', sensitive: false, placeholder: 'octocat' },
    ],
  },
  {
    key: 'aws',
    label: 'Amazon Web Services',
    color: '#FF9900',
    icon: '☁',
    docsUrl: 'https://console.aws.amazon.com/iam/',
    fields: [
      { key: 'accessKeyId', label: 'Access Key ID', sensitive: false, placeholder: 'AKIAIOSFODNN7EXAMPLE' },
      { key: 'secretAccessKey', label: 'Secret Access Key', sensitive: true, placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { key: 'region', label: 'Default Region', sensitive: false, placeholder: 'us-east-1' },
    ],
  },
  {
    key: 'gcp',
    label: 'Google Cloud Platform',
    color: '#4285F4',
    icon: '◈',
    docsUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    fields: [
      { key: 'projectId', label: 'Project ID', sensitive: false, placeholder: 'my-gcp-project-123' },
      { key: 'serviceAccountJson', label: 'Service Account JSON', sensitive: true, placeholder: '{ "type": "service_account", ... }', multiline: true },
    ],
  },
  {
    key: 'azure',
    label: 'Microsoft Azure',
    color: '#0078D4',
    icon: '◆',
    docsUrl: 'https://portal.azure.com/',
    fields: [
      { key: 'clientId', label: 'Client ID (App ID)', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'clientSecret', label: 'Client Secret', sensitive: true, placeholder: 'your-client-secret-value' },
      { key: 'subscriptionId', label: 'Subscription ID', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'tenantId', label: 'Tenant ID', sensitive: false, placeholder: '00000000-0000-0000-0000-000000000000' },
    ],
  },
  {
    key: 'do',
    label: 'DigitalOcean',
    color: '#0080FF',
    icon: '●',
    docsUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    fields: [
      { key: 'token', label: 'API Token', sensitive: true, placeholder: 'dop_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  {
    key: 'hetzner',
    label: 'Hetzner Cloud',
    color: '#D50C2D',
    icon: '▚',
    // Tokens are per-project in Hetzner Cloud, minted under that project's Security page — there
    // is no account-wide token, so this deep-links to the project list rather than a settings page.
    docsUrl: 'https://console.hetzner.cloud/projects',
    fields: [
      { key: 'token', label: 'API Token (Read & Write)', sensitive: true, placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  {
    key: 'cloudflare',
    label: 'Cloudflare DNS',
    color: '#F38020',
    icon: '☁',
    // Unlike the others this is not a compute provider — it is only used to manage the platform's
    // own DNS records when standing up or moving the root node. Tenant provisioning never touches
    // it.
    docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    fields: [
      // A *scoped* token, not the Global API Key: Zone → DNS → Edit on the one zone is everything
      // this needs, and the Global Key would grant account-wide access with no way to narrow it.
      { key: 'token', label: 'API Token (Zone → DNS → Edit)', sensitive: true, placeholder: 'scoped token, not the Global API Key' },
      { key: 'zone', label: 'Zone (Optional)', sensitive: false, placeholder: 'nowrinkles.dev' },
    ],
  },
  {
    key: 'vultr',
    label: 'Vultr',
    color: '#007BFC',
    icon: '◆',
    docsUrl: 'https://my.vultr.com/settings/#settingsapi',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'Settings → API → Personal Access Token' },
    ],
  },
  {
    key: 'linode',
    label: 'Linode / Akamai',
    color: '#00A95C',
    icon: '▲',
    docsUrl: 'https://cloud.linode.com/profile/tokens',
    fields: [
      { key: 'token', label: 'Personal Access Token', sensitive: true, placeholder: 'Profile → API Tokens → Create' },
    ],
  },
  {
    key: 'scaleway',
    label: 'Scaleway',
    color: '#4F0599',
    icon: '❯',
    docsUrl: 'https://console.scaleway.com/iam/api-keys',
    fields: [
      // The SECRET key is what authenticates; the access key is only an identifier, which is why
      // it's the optional one here.
      { key: 'secretKey', label: 'Secret Key', sensitive: true, placeholder: 'Shown once when the API key is created' },
      { key: 'accessKey', label: 'Access Key (Optional)', sensitive: false, placeholder: 'SCWXXXXXXXXXXXXXXXXX' },
      { key: 'projectId', label: 'Project ID (Optional)', sensitive: false, placeholder: 'Needed only to create servers, not to browse plans' },
    ],
  },
  {
    key: 'hostinger',
    label: 'Hostinger',
    color: '#673DE6',
    icon: '◇',
    docsUrl: 'https://hpanel.hostinger.com/api-tokens',
    fields: [
      { key: 'token', label: 'API Token', sensitive: true, placeholder: 'hPanel → API tokens (free with any VPS plan)' },
    ],
  },
  {
    key: 'contabo',
    label: 'Contabo',
    color: '#0A5FA5',
    icon: '▣',
    docsUrl: 'https://my.contabo.com/api/details',
    fields: [
      // Contabo is the only provider here using an OAuth2 password grant rather than one token.
      { key: 'clientId', label: 'Client ID', sensitive: true, placeholder: 'API → Details → Client ID' },
      { key: 'clientSecret', label: 'Client Secret', sensitive: true, placeholder: 'API → Details → Client Secret' },
      { key: 'apiUser', label: 'API User (email)', sensitive: false, placeholder: 'your@email.com' },
      { key: 'apiPassword', label: 'API Password', sensitive: true, placeholder: 'Set under API → Details (not your login password)' },
    ],
  },
];

// Providers this platform can actually create a cluster on today, in the order the cluster
// wizard offers them. Everything else in PROVIDERS above is a credential store only (or, for
// aws/gcp/azure/do, still the stubbed scaffolding the distributed-systems plan describes).
export const CLUSTER_CAPABLE_PROVIDERS = ['hetzner'] as const;

/**
 * What connecting each VPS provider actually gets you today, shown on the card so the value is
 * clear before someone goes hunting for a token — and so nobody expects Contabo plans to appear
 * in the catalog when its API publishes no prices at all.
 */
export const PROVIDER_CAPABILITY: Record<string, string> = {
  hetzner: 'Live plan prices in the VPS Catalog, and full cluster provisioning.',
  vultr: 'Vultr plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  linode: 'Linode plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  scaleway: 'Scaleway plans are already in the VPS Catalog (public API) — a token is only needed for future provisioning.',
  do: 'Adds DigitalOcean plan prices to the VPS Catalog.',
  hostinger: 'Adds Hostinger plans to the VPS Catalog once the adapter is verified against a real token.',
  contabo: 'Management access only — Contabo publishes no pricing API, so its plans cannot appear in the VPS Catalog.',
};
