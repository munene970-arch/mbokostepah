'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  initiateLogin,
  initiateSignUp,
  handleOAuthCallback,
  refreshAccessToken,
  fetchAccounts,
  getWebSocketOTP,
  logout as coreLogout,
  getAuthInfo,
  getDerivAccounts,
  getActiveLoginId,
  storeDerivAccounts,
  setActiveLoginId,
  setAccountType,
  clearAllAuthData,
  parseReferralLink,
  parseLandingParams,
  resolveReferralViaProxy,
} from '@deriv/core';
import type { AuthInfo, DerivAccount, AuthState, AuthConfig } from '@deriv/core';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { readStoredLanguage } from '@/lib/i18n';

function getAuthConfig(lang?: string): AuthConfig {
  const config: AuthConfig = {
    clientId: process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '',
    // Empty falls back to the origin so login returns to the host holding the CSRF/PKCE state (#249).
    redirectUri:
      process.env.NEXT_PUBLIC_DERIV_REDIRECT_URI ||
      (typeof window !== 'undefined' ? window.location.origin : ''),
  };

  // Prefer the live UI language; fall back to the namespaced storage key so
  // login/sign-up still forward `lang` if called outside the provider tree.
  const resolvedLang = lang ?? readStoredLanguage();
  if (resolvedLang) {
    config.lang = resolvedLang;
  }

  // Convert comma-separated scopes to space-separated (OAuth spec)
  const scopesEnv = process.env.NEXT_PUBLIC_DERIV_OAUTH_SCOPES ?? '';
  if (scopesEnv) {
    config.scopes = scopesEnv
      .split(',')
      .map(s => s.trim())
      .join(' ');
  }

  const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
  if (referralLink) {
    const referral = parseReferralLink(referralLink);
    if (referral) {
      config.affiliateToken = referral.affiliateToken;
      config.affiliateTokenParam = referral.affiliateTokenParam;
      config.utmCampaign = referral.utmCampaign;
      config.utmSource = referral.utmSource;
      config.utmMedium = referral.utmMedium;
    }
  }

  // Override with live per-click params from landing URL (e.g. Scaleo t= token).
  // These are present in window.location.search when the user arrives via an
  // affiliate link and haven't been removed yet (OAuth params aren't in the URL
  // at this point — they only appear after Deriv redirects back with ?code=).
  const landing = parseLandingParams();
  if (landing) {
    // Only override the token when the landing URL actually carries one (t=).
    // parseLandingParams returns a non-null result for any utm_* param, so an
    // unguarded write would clobber a valid env token with '' on generic
    // marketing links (e.g. ?utm_source=google with no t=).
    if (landing.affiliateToken) {
      config.affiliateToken = landing.affiliateToken;
      config.affiliateTokenParam = landing.affiliateTokenParam;
    }
    if (landing.utmSource) config.utmSource = landing.utmSource;
    if (landing.utmMedium) config.utmMedium = landing.utmMedium;
    if (landing.utmCampaign) config.utmCampaign = landing.utmCampaign;
  }

  return config;
}

// Start the Scaleo referral resolution ahead of a login/sign-up activation.
// The login prompt calls this when it opens, so by the time the user taps a
// CTA the lookup has settled and the click path goes straight to the PKCE
// build and navigation — the same synchronous shape as Trader's
// redirectToLogin, whose crypto-only double-tap window Trader accepts with no
// guard. Consumed (cleared) on use, so a login with no fresh prefetch — the
// header buttons — resolves its own exactly as before.
let pendingReferral: ReturnType<typeof resolveReferralViaProxy> | null = null;

export function prefetchAuthReferral(): void {
  const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
  if (!referralLink) return;
  pendingReferral = resolveReferralViaProxy(referralLink);
}

// Build the auth config and, if we don't already have an affiliate token (from
// a resolved/Format-3 referral link or live landing params), try to resolve a
// fresh per-user token via the app-builder BFF proxy. Strictly non-blocking:
// any failure leaves the config untouched so login/sign-up always proceeds.
async function getAuthConfigWithReferral(lang?: string): Promise<AuthConfig> {
  const config = getAuthConfig(lang);
  if (!config.affiliateToken) {
    try {
      const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
      const pending = pendingReferral ?? resolveReferralViaProxy(referralLink);
      pendingReferral = null;
      const resolved = await pending;
      if (resolved) {
        config.affiliateToken = resolved.affiliateToken;
        config.affiliateTokenParam = resolved.affiliateTokenParam;
        if (resolved.utmSource) config.utmSource = resolved.utmSource;
        if (resolved.utmMedium) config.utmMedium = resolved.utmMedium;
        if (resolved.utmCampaign) config.utmCampaign = resolved.utmCampaign;
      }
    } catch {
      // Never block login on attribution resolution.
    }
  }
  return config;
}

export interface UseAuthReturn {
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  activeAccountId: string | null;
  wsUrl: string | undefined;
  login: () => Promise<void>;
  signUp: () => Promise<void>;
  logout: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  updateAccountBalance: (accountId: string, balance: string, currency?: string) => void;
  error: string | null;
  connectWithPAT: (token: string) => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const { currentLang } = useAppTranslations();
  const [authState, setAuthState] = useState<AuthState>(() =>
    typeof window !== 'undefined' && getAuthInfo() ? 'authenticated' : 'unauthenticated'
  );
  const [accounts, setAccounts] = useState<DerivAccount[]>(() => {
    if (typeof window === 'undefined') return [];
    return getDerivAccounts() ?? [];
  });
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return getActiveLoginId() ?? null;
  });
  const [wsUrl, setWsUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // PAT is intentionally held in component memory only; it is never persisted.
  const [authMethod, setAuthMethod] = useState<'oauth' | 'pat' | null>(() =>
    typeof window !== 'undefined' && getAuthInfo() ? 'oauth' : null
  );
  const initRef = useRef(false);
  const activeAccountIdRef = useRef<string | null>(null);
  const tabHiddenAtRef = useRef<number | null>(null);

  // Fetch OTP WebSocket URL for an account
  const fetchOTPUrl = useCallback(
    async (accountId: string, authInfo?: AuthInfo): Promise<string> => {
      if (authMethod === 'pat') {
        const response = await fetch('/api/deriv/pat/otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ accountId }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not authorize account');
        return payload.url as string;
      }
      if (!authInfo) throw new Error('Please connect your Deriv account again.');
      return getWebSocketOTP(accountId, authInfo, getAuthConfig().clientId);
    },
    [authMethod]
  );

  // Complete auth: fetch accounts → get OTP → set WS URL
  const completeAuth = useCallback(
    async (authInfo: AuthInfo, preferredAccountId?: string | null) => {
      const fetchedAccounts = await fetchAccounts(authInfo, getAuthConfig().clientId);
      setAccounts(fetchedAccounts);

      if (fetchedAccounts.length > 0) {
        const selectedAccount =
          fetchedAccounts.find(account => account.account_id === preferredAccountId) ??
          fetchedAccounts.find(account => account.account_type === 'demo') ??
          fetchedAccounts[0];
        if (selectedAccount.account_type === 'real' && typeof window !== 'undefined') {
          const confirmed = window.confirm('You are connecting to a REAL account. Trades will use real money. Continue?');
          if (!confirmed) throw new Error('Live account connection cancelled.');
        }
        setActiveLoginId(selectedAccount.account_id);
        setAccountType(selectedAccount.account_type);
        setActiveAccountId(selectedAccount.account_id);

        const otpUrl = await fetchOTPUrl(selectedAccount.account_id, authInfo);
        setWsUrl(otpUrl);
      }

      setAuthMethod('oauth');
      setAuthState('authenticated');
    },
    [fetchOTPUrl]
  );

  // Fall back to the cached account snapshot when the fresh fetch fails (e.g.
  // transient network error) instead of forcing a logout. The balance stream
  // reconciles any staleness as soon as the socket connects.
  const restoreCachedSession = useCallback(
    async (authInfo: AuthInfo): Promise<boolean> => {
      const cachedAccounts = getDerivAccounts();
      const loginId = getActiveLoginId() ?? cachedAccounts?.[0]?.account_id;
      if (!cachedAccounts || cachedAccounts.length === 0 || !loginId) return false;

      // Mirror completeAuth: keep the persisted selection in sync as well.
      const selectedAccount = cachedAccounts.find(a => a.account_id === loginId);
      setActiveLoginId(loginId);
      if (selectedAccount) setAccountType(selectedAccount.account_type);
      setAccounts(cachedAccounts);
      setActiveAccountId(loginId);
      try {
        const otpUrl = await fetchOTPUrl(loginId, authInfo);
        setWsUrl(otpUrl);
        setAuthState('authenticated');
        return true;
      } catch {
        return false;
      }
    },
    [fetchOTPUrl]
  );

  // Initialize: check for OAuth callback or existing session
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');

      // Phase 3-5: Handle OAuth callback
      if (code) {
        setAuthState('authenticating');
        try {
          const authInfo = await handleOAuthCallback(window.location.href, getAuthConfig());
          await completeAuth(authInfo);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Authentication failed');
          setAuthState('error');
          clearAllAuthData();
        }
        return;
      }

      // Check for existing session
      const storedAuth = getAuthInfo();
      if (storedAuth) {
        // Check if token is expired
        if (storedAuth.expires_at && Date.now() / 1000 > storedAuth.expires_at) {
          let refreshed: AuthInfo;
          try {
            refreshed = await refreshAccessToken(
              storedAuth.refresh_token,
              getAuthConfig().clientId
            );
          } catch {
            // Refresh failed (token revoked/expired) — fall back to
            // unauthenticated (public WS)
            clearAllAuthData();
            setAuthState('unauthenticated');
            return;
          }
          try {
            await completeAuth(refreshed, getActiveLoginId());
          } catch {
            // Same resilience as the valid-session path: a transient fetch
            // failure after a successful refresh keeps the session alive on
            // the cached snapshot instead of forcing a logout.
            if (!(await restoreCachedSession(refreshed))) {
              clearAllAuthData();
              setAuthState('unauthenticated');
            }
          }
          return;
        }

        // Always refresh the account snapshot. The cached account list is only
        // an initial render fallback and may contain a stale balance.
        try {
          await completeAuth(storedAuth, getActiveLoginId());
        } catch {
          // Fresh fetch failed (e.g. transient network error) — keep the
          // session alive on the cached snapshot rather than logging out.
          if (!(await restoreCachedSession(storedAuth))) {
            clearAllAuthData();
            setAuthState('unauthenticated');
          }
        }
      } else {
        // Restore the encrypted HttpOnly PAT session without exposing the token to JavaScript.
        try {
          const response = await fetch('/api/deriv/pat/accounts', { method: 'GET', cache: 'no-store' });
          if (!response.ok) return;
          const payload = await response.json();
          const restoredAccounts = (Array.isArray(payload.accounts) ? payload.accounts : []) as DerivAccount[];
          if (!restoredAccounts.length) return;
          const preferredId = getActiveLoginId();
          const selected = restoredAccounts.find(account => account.account_id === preferredId) ??
            restoredAccounts.find(account => account.account_type === 'demo') ?? restoredAccounts[0];
          if (selected.account_type === 'real' && typeof window !== 'undefined') {
            const confirmed = window.confirm('You are reconnecting to a REAL account. Trades will use real money. Continue?');
            if (!confirmed) return;
          }
          const otpResponse = await fetch('/api/deriv/pat/otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ accountId: selected.account_id }),
          });
          const otpPayload = await otpResponse.json();
          if (!otpResponse.ok) throw new Error(otpPayload.error || 'PAT session could not be restored.');
          setAuthMethod('pat');
          setAccounts(restoredAccounts);
          storeDerivAccounts(restoredAccounts);
          setActiveLoginId(selected.account_id);
          setAccountType(selected.account_type);
          setActiveAccountId(selected.account_id);
          setWsUrl(otpPayload.url as string);
          setAuthState('authenticated');
        } catch {
          setAuthMethod(null);
        }
      }
    };

    init();
  }, [completeAuth, fetchOTPUrl, restoreCachedSession]);

  // Keep ref in sync so visibility handler always has the current account ID
  useEffect(() => {
    activeAccountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  // Refresh the OTP WebSocket URL when returning to the tab after >30s of inactivity.
  // OTP URLs are single-use, so a stale URL will cause reconnect failures.
  useEffect(() => {
    if (authState !== 'authenticated') return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        tabHiddenAtRef.current = Date.now();
        return;
      }

      const hiddenAt = tabHiddenAtRef.current;
      if (!hiddenAt || Date.now() - hiddenAt < 30_000) return;
      tabHiddenAtRef.current = null;

      const accountId = activeAccountIdRef.current;
      const authInfo = getAuthInfo();
      if ((!authInfo && authMethod !== 'pat') || !accountId) return;

      try {
        const otpUrl = await fetchOTPUrl(accountId, authInfo ?? undefined);
        setWsUrl(otpUrl);
      } catch {
        clearAllAuthData();
        setAuthState('unauthenticated');
        setWsUrl(undefined);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authState, fetchOTPUrl, authMethod]);

  // Phase 1: Initiate login — includes partner attribution params, resolving a
  // fresh per-user Scaleo token via the BFF proxy when needed (non-blocking).
  // Forwards `lang` so Deriv's home app continues in the selected language (#559).
  const login = useCallback(async () => {
    await initiateLogin(await getAuthConfigWithReferral(currentLang));
  }, [currentLang]);

  // Initiate sign-up — adds prompt=registration and partner attribution params
  const signUp = useCallback(async () => {
    await initiateSignUp(await getAuthConfigWithReferral(currentLang));
  }, [currentLang]);

  // Connect with a PAT. The server encrypts it into an HttpOnly session cookie;
  // client-side code never stores or reads the PAT after this request.
  const connectWithPAT = useCallback(async (token: string) => {
    const cleanToken = token.trim();
    if (!cleanToken) throw new Error('Enter your Deriv PAT.');
    setAuthState('authenticating');
    setError(null);
    try {
      const response = await fetch('/api/deriv/pat/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token: cleanToken }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Deriv rejected this PAT.');
      const fetchedAccounts = (Array.isArray(payload.accounts) ? payload.accounts : []) as DerivAccount[];
      if (!fetchedAccounts.length) throw new Error('No Options trading accounts were found for this PAT.');
      const selected = fetchedAccounts.find(account => account.account_type === 'demo') ?? fetchedAccounts[0];
      if (selected.account_type === 'real' && typeof window !== 'undefined') {
        const confirmed = window.confirm('You only have a REAL account available. Trades will use real money. Continue?');
        if (!confirmed) throw new Error('Live account connection cancelled.');
      }
      const otpResponse = await fetch('/api/deriv/pat/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ accountId: selected.account_id }),
      });
      const otpPayload = await otpResponse.json();
      if (!otpResponse.ok) throw new Error(otpPayload.error || 'Could not connect to the selected account.');
      setAuthMethod('pat');
      setAccounts(fetchedAccounts);
      storeDerivAccounts(fetchedAccounts);
      setActiveLoginId(selected.account_id);
      setAccountType(selected.account_type);
      setActiveAccountId(selected.account_id);
      setWsUrl(otpPayload.url as string);
      setAuthState('authenticated');
    } catch (err) {
      await fetch('/api/deriv/pat/session', { method: 'DELETE', cache: 'no-store' }).catch(() => undefined);
      setError(err instanceof Error ? err.message : 'PAT connection failed.');
      setAuthState('error');
      throw err;
    }
  }, []);

  // Logout: close WS (handled by useDerivWS cleanup), clear storage, reset state
  const logout = useCallback(() => {
    setAuthMethod(null);
    void fetch('/api/deriv/pat/session', { method: 'DELETE', cache: 'no-store' }).catch(() => undefined);
    coreLogout();
    setAccounts([]);
    setActiveAccountId(null);
    setWsUrl(undefined);
    setAuthState('unauthenticated');
    setError(null);
  }, []);

  // Account switch: fetch new OTP first, then update accountId and wsUrl together
  // so reconnectKey and url change in the same render cycle with the correct OTP.
  const switchAccount = useCallback(
    async (accountId: string) => {
      const authInfo = getAuthInfo();
      if (!authInfo && authMethod !== 'pat') return;

      try {
        const account = accounts.find(a => a.account_id === accountId);
        if (account?.account_type === 'real' && typeof window !== 'undefined') {
          const confirmed = window.confirm('You are switching to a REAL account. Trades will use real money. Continue?');
          if (!confirmed) return;
        }
        if (account) setAccountType(account.account_type);
        // Fetch OTP before updating accountId so reconnectKey and url are consistent
        const otpUrl = await fetchOTPUrl(accountId, authInfo ?? undefined);
        setActiveLoginId(accountId);
        setActiveAccountId(accountId);
        setWsUrl(otpUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Account switch failed');
      }
    },
    [fetchOTPUrl, accounts, authMethod]
  );

  // Keep the account snapshot and its persisted fallback synchronized with
  // authenticated balance stream updates.
  const updateAccountBalance = useCallback(
    (accountId: string, balance: string, currency?: string) => {
      setAccounts(currentAccounts => {
        let changed = false;
        const updatedAccounts = currentAccounts.map(account => {
          if (account.account_id !== accountId) return account;

          const updatedCurrency = currency ?? account.currency;
          if (account.balance === balance && account.currency === updatedCurrency) {
            return account;
          }

          changed = true;
          return { ...account, balance, currency: updatedCurrency };
        });

        if (!changed) return currentAccounts;
        storeDerivAccounts(updatedAccounts);
        return updatedAccounts;
      });
    },
    []
  );

  const activeAccount =
    accounts.find(acc => acc.account_id === activeAccountId) ?? accounts[0] ?? null;

  return {
    authState,
    accounts,
    activeAccount,
    activeAccountId,
    wsUrl,
    login,
    signUp,
    logout,
    switchAccount,
    updateAccountBalance,
    error,
    connectWithPAT,
  };
}
