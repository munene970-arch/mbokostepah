import { NextResponse } from 'next/server';
import { DERIV_PAT_COOKIE } from '@/lib/deriv-pat-session';

export const runtime = 'nodejs';

export async function DELETE() {
  const response = NextResponse.json({ ok: true }, {
    headers: { 'Cache-Control': 'no-store, private' },
  });
  response.cookies.set(DERIV_PAT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
