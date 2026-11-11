import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function appId() {
  return process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
    const id = appId();

    if (!token || token.length > 4096 || !/^[A-Za-z0-9]+$/.test(accountId)) {
      return NextResponse.json({ error: 'Invalid token or account selection.' }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ error: 'Deriv App ID is not configured on the server.' }, { status: 500 });
    }

    const upstream = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Deriv-App-ID': id,
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
    return NextResponse.json({ error: 'Unable to authorize the selected account.' }, { status: 502 });
  }
}
