/**
 * DingTalk app-registration device flow (扫码一键配置).
 *
 * Endpoint family: https://oapi.dingtalk.com/app/registration/{init,begin,poll}
 * Verified against the live API (2026-10): `init` accepts any non-empty source
 * string (no partner allowlist), `begin` returns a verification_uri_complete
 * that the DingTalk mobile app can scan, and after the user confirms inside
 * DingTalk (choose org + approve), `poll` returns client_id/client_secret for
 * a freshly created internal app. The OpenClaw/LobsterAI ecosystem uses the
 * same flow (source "DING_DWS_CLAW"); we identify ourselves as "PI_DESKTOP".
 *
 * This API family is not in the public docs; if DingTalk changes or retires
 * it, callers must degrade to the manual-config path (kept as a dialog tab).
 */

export const DINGTALK_REG_SOURCE = 'PI_DESKTOP';
const REG_BASE = 'https://oapi.dingtalk.com';

export interface DingTalkRegistrationSession {
  /** QR payload — DingTalk scan lands on the org/authorize page. */
  url: string;
  deviceCode: string;
  /** Short code shown on the authorize page; user confirms it matches. */
  userCode: string;
  intervalMs: number;
  expireInMs: number;
}

export type DingTalkPollStatus = 'waiting' | 'success' | 'fail' | 'expired';

export interface DingTalkRegistrationPollResult {
  done: boolean;
  status: DingTalkPollStatus;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}

type FetchLike = (url: string, init?: { method: string; headers: Record<string, string>; body: string }) => Promise<{ json(): Promise<unknown> }>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<{ json(): Promise<unknown> }>;

async function postJson<T>(path: string, body: Record<string, unknown>, fetchImpl: FetchLike): Promise<T> {
  const res = await fetchImpl(`${REG_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Steps 1+2: init (nonce) → begin (device_code + QR url). Throws on API error. */
export async function startDingTalkRegistration(fetchImpl: FetchLike = defaultFetch): Promise<DingTalkRegistrationSession> {
  const initData = await postJson<{ errcode: number; errmsg?: string; nonce?: string }>('/app/registration/init', { source: DINGTALK_REG_SOURCE }, fetchImpl);
  if (initData.errcode !== 0 || !initData.nonce) throw new Error(initData.errmsg || '钉钉注册初始化失败');

  const beginData = await postJson<{ errcode: number; errmsg?: string; device_code?: string; verification_uri_complete?: string; user_code?: string; interval?: number; expires_in?: number }>('/app/registration/begin', { nonce: initData.nonce }, fetchImpl);
  if (beginData.errcode !== 0 || !beginData.device_code || !beginData.verification_uri_complete) {
    throw new Error(beginData.errmsg || '钉钉注册会话创建失败');
  }
  return {
    url: beginData.verification_uri_complete,
    deviceCode: beginData.device_code,
    userCode: beginData.user_code ?? '',
    intervalMs: Math.max(beginData.interval ?? 2, 2) * 1000,
    expireInMs: (beginData.expires_in ?? 7200) * 1000,
  };
}

/** Step 3: poll. Returns a terminal status (success/fail/expired) or waiting. */
export async function pollDingTalkRegistration(deviceCode: string, fetchImpl: FetchLike = defaultFetch): Promise<DingTalkRegistrationPollResult> {
  const data = await postJson<{ errcode: number; errmsg?: string; status?: string; client_id?: string; client_secret?: string; fail_reason?: string }>('/app/registration/poll', { device_code: deviceCode }, fetchImpl);
  if (data.errcode !== 0) return { done: false, status: 'waiting', error: data.errmsg || 'poll error' };
  const status = (data.status ?? '').toUpperCase();
  if (status === 'SUCCESS' && data.client_id && data.client_secret) {
    return { done: true, status: 'success', clientId: data.client_id, clientSecret: data.client_secret };
  }
  if (status === 'FAIL') return { done: true, status: 'fail', error: data.fail_reason || '授权失败' };
  if (status === 'EXPIRED') return { done: true, status: 'expired', error: '授权已过期' };
  return { done: false, status: 'waiting' };
}
