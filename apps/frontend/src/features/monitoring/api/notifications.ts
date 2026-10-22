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
