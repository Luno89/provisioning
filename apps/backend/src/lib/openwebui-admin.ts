import type { InfrastructureService } from '../services/InfrastructureService.js';

export interface OpenWebUiWebSearchPatch {
  enableWebSearch?: boolean;
  webSearchEngine?: string;
  webSearchApiKey?: string;
}

const API_KEY_FIELD: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  serper: 'SERPER_API_KEY',
  bing: 'BING_SEARCH_V7_SUBSCRIPTION_KEY',
};

export async function pushOpenWebUiWebSearchConfig(
  infra: InfrastructureService,
  kubeconfigPath: string,
  namespace: string,
  patch: OpenWebUiWebSearchPatch,
): Promise<void> {
  if (patch.enableWebSearch === undefined && patch.webSearchEngine === undefined && patch.webSearchApiKey === undefined) {
    return;
  }

  const apiKeyField = patch.webSearchEngine ? API_KEY_FIELD[patch.webSearchEngine] : undefined;
  const overlayLines = [
    patch.enableWebSearch !== undefined ? `web['ENABLE_WEB_SEARCH'] = ${patch.enableWebSearch ? 'True' : 'False'}` : '',
    patch.webSearchEngine !== undefined ? `web['WEB_SEARCH_ENGINE'] = ${JSON.stringify(patch.webSearchEngine)}` : '',
    apiKeyField && patch.webSearchApiKey ? `web[${JSON.stringify(apiKeyField)}] = ${JSON.stringify(patch.webSearchApiKey)}` : '',
  ].filter(Boolean).join('\n    ');

  const script = `
import sqlite3, jwt, uuid, json, urllib.request, sys
from datetime import datetime, timezone

try:
    with open('/app/backend/.webui_secret_key') as f:
        secret = f.read().strip()
    conn = sqlite3.connect('/app/backend/data/webui.db')
    cur = conn.cursor()
    cur.execute("SELECT id FROM user WHERE role='admin' ORDER BY created_at LIMIT 1")
    row = cur.fetchone()
    if row is None:
        print('SKIP: no admin user yet - fresh deployment, env vars will seed it on first boot')
        sys.exit(0)
    uid = row[0]
    payload = {'id': uid, 'jti': str(uuid.uuid4()), 'iat': datetime.now(timezone.utc)}
    token = jwt.encode(payload, secret, algorithm='HS256')
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

    req = urllib.request.Request('http://localhost:8080/api/v1/retrieval/config', headers=headers)
    current = json.loads(urllib.request.urlopen(req, timeout=15).read())
    web = current['web']
    ${overlayLines}

    body = json.dumps({'web': web}).encode()
    req2 = urllib.request.Request('http://localhost:8080/api/v1/retrieval/config/update', data=body, headers=headers, method='POST')
    urllib.request.urlopen(req2, timeout=15)
    print('OK: pushed web search config via Open WebUI admin API')
except Exception as e:
    print(f'FAIL: {e}')
    sys.exit(1)
`.trim();

  try {
    const output = await infra.runKubectl(
      ['exec', '-n', namespace, 'deployment/open-webui', '--', 'python3', '-c', script],
      kubeconfigPath,
    );
    console.log(`[openwebui-admin] ${String(output).trim()}`);
  } catch (err: any) {
    console.warn(`[openwebui-admin] failed to push web search config via admin API: ${err.message}`);
  }
}
