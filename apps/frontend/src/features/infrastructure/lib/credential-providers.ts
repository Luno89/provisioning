import type { DnsProviderInfo } from '../types/credentials';

interface ProviderMeta {
  key: string;
  label: string;
  color: string;
  icon: string;
  docsUrl: string;
  fields: { key: string; label: string; sensitive: boolean; placeholder: string; multiline?: boolean }[];
  connectsWithAccount?: boolean;
  capability?: string;
}

export const withDnsProviders = (providers: readonly ProviderMeta[], dns: readonly DnsProviderInfo[]): ProviderMeta[] => [
  ...providers,
  ...dns.map((provider) => ({
    key: provider.name,
    label: provider.label,
    color: '#64748B',
    icon: '◎',
    docsUrl: provider.docsUrl,
    capability: provider.setup,
    fields: provider.fields.map((field) => ({ key: field.key, label: field.label, sensitive: field.secret, placeholder: field.placeholder })),
  })),
];

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
    key: 'ovh',
    label: 'OVHcloud',
    color: '#123F6D',
    icon: '◈',
    docsUrl: 'https://ca.api.ovh.com/createToken/',
    fields: [
      { key: 'applicationKey', label: 'Application key', sensitive: true, placeholder: 'From createToken on your region\'s API (eu.api.ovh.com, ca.api.ovh.com or api.us.ovhcloud.com)' },
      { key: 'applicationSecret', label: 'Application secret', sensitive: true, placeholder: 'Shown once, beside the application key' },
      { key: 'consumerKey', label: 'Consumer key', sensitive: true, placeholder: 'Rules: GET /*, POST /order/*, DELETE /order/*, POST /vps/*, POST /me/order/*, POST /ip/*' },
      { key: 'subsidiary', label: 'Account subsidiary', sensitive: false, placeholder: 'AU, CA, FR, GB, US…' },
    ],
  },
];

export const LLM_PROVIDERS: ProviderMeta[] = [
  {
    key: 'openrouter',
    label: 'OpenRouter',
    color: '#FF6600',
    icon: '◇',
    docsUrl: 'https://openrouter.ai/keys',
    fields: [{ key: 'apiKey', label: 'API Key', sensitive: true, placeholder: 'sk-or-v1-...' }],
    connectsWithAccount: true,
  },
  {
    key: 'groq',
    label: 'Groq',
    color: '#F55036',
    icon: '⚡',
    docsUrl: 'https://console.groq.com/keys',
    fields: [{ key: 'apiKey', label: 'API Key', sensitive: true, placeholder: 'gsk_...' }],
  },
  {
    key: 'together',
    label: 'Together AI',
    color: '#FF6B6B',
    icon: '◆',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    fields: [{ key: 'apiKey', label: 'API Key', sensitive: true, placeholder: 'xxxxxxxx' }],
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    color: '#FF9900',
    icon: '◈',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    fields: [{ key: 'apiKey', label: 'API Key', sensitive: true, placeholder: 'xxxxxxxx' }],
  },
  {
    key: 'custom',
    label: 'Custom Endpoint',
    color: '#6366F1',
    icon: '🔌',
    docsUrl: '',
    fields: [
      { key: 'baseUrl', label: 'Base URL', sensitive: false, placeholder: 'https://your-api.com/v1' },
      { key: 'apiKey', label: 'API Key (optional)', sensitive: true, placeholder: 'sk-...' },
      { key: 'model', label: 'Model Name', sensitive: false, placeholder: 'gpt-4o-mini' },
    ],
  },
];

export const PROVIDER_CAPABILITY: Record<string, string> = {
  ovh: 'Lets Koala buy a server for its root from Infrastructure → Clusters → Host Koala on a server. Your OVHcloud account needs a default payment method; nothing is bought until you confirm the price.',
};
