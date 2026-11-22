import { site } from './api.js';

export type SessionPath = `/sessions/${string}`;

export const login = (session: SessionPath) => site.post(`${session}/login`, {});
