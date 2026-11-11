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
    const id = appId();
    if (!token || token.length > 4096) {
      return NextResponse.json({ error: 'Enter a valid Deriv PAT.' }, { status: 400 });
    }
    if (!id) {
      return NextResponse.json({ error: 'Deriv App ID is not configured on the server.' }, { status: 500 });
    }

    const upstream = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Deriv-App-ID': id,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    const payload = await upstream.json();
    if (!upstream.ok) {
      const message = payload?.errors?.[0]?.message || 'Deriv could not validate this token.';
      return NextResponse.json({ error: message }, { status: upstream.status });
    }

    const data = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
    return NextResponse.json({ accounts: data }, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch {
    return NextResponse.json({ error: 'Unable to contact Deriv. Please try again.' }, { status: 502 });
  }
}
