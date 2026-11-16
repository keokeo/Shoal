let onUnauthorized: (() => void) | null = null;

export function setMobileUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    onUnauthorized?.();
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw Object.assign(new Error(json.error ?? `请求失败 (${res.status})`), { status: res.status, code: json.code });
  }
  return json as T;
}

export async function mobileGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  return handleResponse<T>(res);
}

export async function mobilePost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function mobilePatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function mobileUploadImage(file: File): Promise<string> {
  const type = file.type || 'image/png';
  const res = await fetch('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': type, 'x-shoal-mobile': '1' },
    body: file,
  });
  const json = await handleResponse<{ name: string }>(res);
  return json.name;
}
