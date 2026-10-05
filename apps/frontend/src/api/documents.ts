import { api } from './client.js';
import type { DocumentAddress, OpenedDocument } from '../types/documents';

export const documentKeys = {
  one: (address: DocumentAddress) => ['document', address.workspace, address.path, address.at ?? 'main'] as const,
};

export async function readDocument(address: DocumentAddress): Promise<OpenedDocument> {
  const params = { path: address.path, ...(address.at ? { at: address.at } : {}) };
  return (await api.get<OpenedDocument>(`/documents/${encodeURIComponent(address.workspace)}`, { params })).data;
}
