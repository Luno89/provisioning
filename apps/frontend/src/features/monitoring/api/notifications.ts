import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `EmailChoice` in apps/backend/src/platform/lib/mail.ts and `NotificationView` in
 * apps/backend/src/monitoring/services/NotificationService.ts.
 */
export type EmailChoice = 'off' | 'all' | 'down'

export interface NotificationView {
  email: EmailChoice
  available: { ok: true } | { ok: false; why: string }
  address?: string
}

export const notificationKeys = {
  mine: () => ['notifications'] as const,
}

export async function getNotifications(): Promise<NotificationView> {
  return (await api.get<NotificationView>('/notifications')).data
}

export async function setEmailChoice(email: EmailChoice): Promise<NotificationView> {
  return (await api.put<NotificationView>('/notifications', { email })).data
}

export async function sendTestEmail(): Promise<void> {
  await api.post('/notifications/test-email')
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `PushView` and `PushDevice` in apps/backend/src/monitoring/services/PushService.ts and lib/web-push.ts.
 */
export interface PushDevice {
  id: string
  label: string
  endpoint: string
  createdAt: string
}

export interface PushView {
  publicKey: string
  devices: PushDevice[]
}

export const pushKeys = {
  mine: () => ['notifications', 'push'] as const,
}

export async function getPush(): Promise<PushView> {
  return (await api.get<PushView>('/notifications/push')).data
}

export async function addPushDevice(subscription: unknown): Promise<PushView> {
  return (await api.post<PushView>('/notifications/push', { subscription })).data
}

export async function removePushDevice(id: string): Promise<PushView> {
  return (await api.delete<PushView>(`/notifications/push/${encodeURIComponent(id)}`)).data
}

export async function sendTestPush(): Promise<{ sent: number }> {
  return (await api.post<{ sent: number }>('/notifications/push/test')).data
}
