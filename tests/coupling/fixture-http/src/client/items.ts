import { api } from './api.js';

export const openItem = (id: string) => api.get(`/items/${id}`);
export const discardItem = (id: string) => api.post(`/items/${id}/discard`, {});
export const acceptItem = (id: string) => api.post(`/items/${id}/accept`, {});
export const itemNotes = (id: string) => api.get(`/items/${id}/notes`);
export const nowhere = () => api.get('/nowhere');
