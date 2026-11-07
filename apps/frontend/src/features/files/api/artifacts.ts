import { API_BASE } from '../../../api/client'

export const artifactUrl = (id: string): string => `${API_BASE}/artifacts/${encodeURIComponent(id)}`

export const withArtifactAddresses = (text: string): string => text.replace(/\(\/api\/artifacts\//g, `(${API_BASE}/artifacts/`)
