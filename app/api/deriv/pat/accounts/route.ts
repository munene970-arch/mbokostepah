import { NextRequest, NextResponse } from 'next/server';
import {
  decryptDerivPAT,
  DERIV_PAT_COOKIE,
  DERIV_PAT_SESSION_SECONDS,
  encryptDerivPAT,
} from '@/lib/deriv-pat-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function appId() {
  return process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '';
}

async function getAccounts(token: string) {
  const id = appId();
  if (!id) throw new Error('Deriv App ID is not configured on the server.');
  const response = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Deriv-App-ID': id,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || 'Deriv could not validate this token.';
    throw Object.assign(new Error(message), { status: response.status });
  }
  return Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 4096) {
      return NextResponse.json({ error: 'Enter a valid Deriv PAT.' }, { status: 400 });
    }
    const accounts = await getAccounts(token);
    if (!accounts.length) {
      return NextResponse.json({ error: 'No Options trading accounts were found for this PAT.' }, { status: 404 });
    }

    const response = NextResponse.json({ accounts }, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
    response.cookies.set(DERIV_PAT_COOKIE, encryptDerivPAT(token), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: DERIV_PAT_SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error
      ? Number((error as { status: number }).status)
      : 502;
    const message = error instanceof Error ? error.message : 'Unable to contact Deriv.';
    return NextResponse.json({ error: message }, { status: status >= 400 && status <= 599 ? status : 502 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const encrypted = request.cookies.get(DERIV_PAT_COOKIE)?.value;
    if (!encrypted) return NextResponse.json({ error: 'No active PAT session.' }, { status: 401 });
    const token = decryptDerivPAT(encrypted);
    const accounts = await getAccounts(token);
    return NextResponse.json({ accounts }, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch {
    return NextResponse.json({ error: 'PAT session expired or invalid.' }, { status: 401 });
  }
}
