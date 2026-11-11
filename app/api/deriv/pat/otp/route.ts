import { NextRequest, NextResponse } from 'next/server';
import { decryptDerivPAT, DERIV_PAT_COOKIE } from '@/lib/deriv-pat-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const encrypted = request.cookies.get(DERIV_PAT_COOKIE)?.value;
    if (!encrypted) return NextResponse.json({ error: 'No active PAT session. Reconnect your PAT.' }, { status: 401 });
    const token = decryptDerivPAT(encrypted);
    const body = await request.json();
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
    if (!/^[A-Za-z0-9]+$/.test(accountId)) {
      return NextResponse.json({ error: 'Invalid account selection.' }, { status: 400 });
    }

    const appId = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '';
    if (!appId) {
      return NextResponse.json({ error: 'Deriv App ID is not configured on the server.' }, { status: 500 });
    }
    const upstream = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Deriv-App-ID': appId,
          Accept: 'application/json',
        },
        cache: 'no-store',
      }
    );
    const payload = await upstream.json();
    if (!upstream.ok) {
      const message = payload?.errors?.[0]?.message || 'Could not authorize this Deriv account.';
      return NextResponse.json({ error: message }, { status: upstream.status });
    }
    const url = payload?.data?.url;
    if (typeof url !== 'string' || !url.startsWith('wss://api.derivws.com/')) {
      return NextResponse.json({ error: 'Deriv returned an invalid WebSocket address.' }, { status: 502 });
    }
    return NextResponse.json({ url }, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch {
    return NextResponse.json({ error: 'PAT session expired or invalid. Please reconnect.' }, { status: 401 });
  }
}
