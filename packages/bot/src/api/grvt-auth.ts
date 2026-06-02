// GRVT Authentication Module - Fase 3
// Auth via edge.grvt.io con cookie-based auth + IPv4 forzado
// Implementado según specs verificadas por Marta

import dns from 'dns';
import http from 'http';
import https from 'https';
import dotenv from 'dotenv';
import { Agent, fetch as undiciFetch } from 'undici';

dotenv.config();

// 🚨 CRÍTICO: Forzar IPv4 globalmente 
dns.setDefaultResultOrder('ipv4first');

// Agente HTTP con IPv4 forzado (para undici)
const ipv4Agent = new Agent({ connect: { family: 4 } });

// Override global fetch with undici (supports agent option properly)
const fetchIPv4 = (url: string, init?: any): Promise<Response> => {
  return undiciFetch(url, { ...init, dispatcher: ipv4Agent }) as unknown as Promise<Response>;
};

// Legacy agents (keep for compatibility)
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

export interface AuthState {
  gravityCookie: string;
  accountId: string;
  isAuthenticated: boolean;
  expiresAt: number;
  loginTime: number;
}

export function createEmptyAuthState(): AuthState {
  return {
    gravityCookie: '',
    accountId: '',
    isAuthenticated: false,
    expiresAt: 0,
    loginTime: 0,
  };
}

let authState: AuthState = createEmptyAuthState();

export async function authenticateGRVT(): Promise<boolean> {
  try {
    console.log('🔐 Autenticando con GRVT Edge API...');
    
    const apiKey = process.env.GRVT_API_KEY;
    if (!apiKey) {
      throw new Error('GRVT_API_KEY no encontrada en .env');
    }

    const response = await fetchIPv4('https://edge.grvt.io/auth/api_key/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GRVT-Grid-Bot/1.0'
      },
      body: JSON.stringify({
        api_key: apiKey
      }),
    });

    console.log(`📡 Login response: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Login failed:', response.status, errorText);
      return false;
    }

    console.log('✅ GRVT login ok, headers:', Object.fromEntries(response.headers.entries()));

    const setCookie = response.headers.get('set-cookie');
    const accountId = response.headers.get('x-grvt-account-id');

    if (!setCookie || !accountId) {
      console.error('❌ Missing auth headers in response');
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
      return false;
    }

    const gravityMatch = setCookie.match(/gravity=([^;]+)/);
    if (!gravityMatch || !gravityMatch[1]) {
      console.error('❌ Gravity cookie not found in Set-Cookie header');
      return false;
    }

    const gravityCookie = gravityMatch[1];
    const now = Date.now();
    
    authState = {
      gravityCookie,
      accountId,
      isAuthenticated: true,
      expiresAt: now + (23 * 60 * 60 * 1000),
      loginTime: now
    };

    console.log('✅ Auth exitoso!');
    console.log(`🆔 Account ID: ${accountId}`);
    console.log(`🍪 Cookie expires in: ${Math.floor((authState.expiresAt - now) / 1000 / 3600)}h`);
    
    return true;

  } catch (error) {
    console.error('❌ Auth error:', error instanceof Error ? error.message : error);
    authState.isAuthenticated = false;
    return false;
  }
}

function needsReauth(): boolean {
  if (!authState.isAuthenticated) return true;
  
  const now = Date.now();
  const timeLeft = authState.expiresAt - now;
  
  if (timeLeft < 60 * 60 * 1000) {
    console.log('⏰ Cookie expirando pronto, re-autenticando...');
    return true;
  }
  
  return false;
}

async function ensureAuthenticated(): Promise<void> {
  if (needsReauth()) {
    const success = await authenticateGRVT();
    if (!success) {
      throw new Error('Falló re-autenticación con GRVT');
    }
  }
}

export async function authenticatedRequest(
  url: string, 
  body: object = {}, 
  options: {
    method?: string;
    timeout?: number;
  } = {}
): Promise<any> {
  await ensureAuthenticated();
  
  const { method = 'POST', timeout = 30000 } = options;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cookie': `gravity=${authState.gravityCookie}`,
    'X-Grvt-Account-Id': authState.accountId,
    'User-Agent': 'GRVT-Grid-Bot/1.0'
  };
  
  try {
    if (url.includes('open_orders')) {
      console.log(`🔍 DEBUG open_orders - Cookie: ${authState.gravityCookie.substring(0, 20)}... AccountId: ${authState.accountId} Body: ${JSON.stringify(body)}`);
    }
    const response = await fetchIPv4(url, {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });

    console.log(`📡 ${method} ${url} → ${response.status}`);

    if (response.status === 401) {
      console.log('🔒 Token expirado, reautenticando...');
      authState.isAuthenticated = false;
      await ensureAuthenticated();
      return await authenticatedRequest(url, body, options);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as { result?: unknown; [k: string]: unknown };
    return data.result ?? data;

  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

export async function publicRequest(
  url: string,
  body: object = {},
  options: { timeout?: number } = {}
): Promise<any> {
  const { timeout = 15000 } = options;
  
  try {
    const response = await fetchIPv4(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GRVT-Grid-Bot/1.0'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });

    console.log(`📡 POST ${url} → ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as { result?: unknown; [k: string]: unknown };
    return data.result ?? data;

  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Public request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

export function getAuthStatus() {
  const now = Date.now();
  const timeLeft = authState.expiresAt - now;
  
  return {
    isAuthenticated: authState.isAuthenticated,
    accountId: authState.accountId,
    hasValidCookie: !!authState.gravityCookie && timeLeft > 0,
    timeLeftHours: Math.max(0, timeLeft / 1000 / 3600),
    loginTime: authState.loginTime ? new Date(authState.loginTime).toISOString() : null,
    expiresAt: authState.expiresAt ? new Date(authState.expiresAt).toISOString() : null
  };
}

export function logout() {
  authState = {
    gravityCookie: '',
    accountId: '',
    isAuthenticated: false,
    expiresAt: 0,
    loginTime: 0
  };
  console.log('🚪 Logged out from GRVT');
}

export async function authenticateWithKey(
  apiKey: string,
  state: AuthState
): Promise<boolean> {
  try {
    console.log('🔐 authenticateWithKey llamado con apiKey:', apiKey.substring(0, 8) + '...');
    
    const response = await fetchIPv4('https://edge.grvt.io/auth/api_key/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GRVT-Grid-Bot/1.0',
      },
      body: JSON.stringify({ api_key: apiKey }),
    });

    console.log('📡 GRVT auth response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ GRVT login failed:', response.status, errorText);
      state.isAuthenticated = false;
      return false;
    }

    console.log('✅ GRVT login ok, headers:', Object.fromEntries(response.headers.entries()));

    const setCookie = response.headers.get('set-cookie');
    const accountId = response.headers.get('x-grvt-account-id');

    if (!setCookie || !accountId) {
      console.error('❌ Missing headers - setCookie:', setCookie, 'accountId:', accountId);
      return false;
    }

    const gravityMatch = setCookie.match(/gravity=([^;]+)/);
    if (!gravityMatch?.[1]) {
      console.error('❌ Gravity cookie not found in:', setCookie);
      return false;
    }

    const now = Date.now();
    state.gravityCookie = gravityMatch[1];
    state.accountId = accountId;
    state.isAuthenticated = true;
    state.expiresAt = now + 23 * 60 * 60 * 1000;
    state.loginTime = now;

    console.log('✅ authenticateWithKey exitoso! accountId:', accountId);
    return true;

  } catch (error) {
    console.error('❌ authenticateWithKey error:', error instanceof Error ? error.message : error);
    state.isAuthenticated = false;
    return false;
  }
}

export async function authenticatedRequestWithState(
  state: AuthState,
  apiKey: string,
  url: string,
  body: object = {},
  options: { method?: string; timeout?: number } = {}
): Promise<any> {
  if (!state.isAuthenticated || (state.expiresAt - Date.now()) < 60 * 60 * 1000) {
    const ok = await authenticateWithKey(apiKey, state);
    if (!ok) throw new Error('GRVT re-authentication failed');
  }

  const { method = 'POST', timeout = 30000 } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cookie': `gravity=${state.gravityCookie}`,
    'X-Grvt-Account-Id': state.accountId,
    'User-Agent': 'GRVT-Grid-Bot/1.0',
  };

  const response = await fetchIPv4(url, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  if (response.status === 401) {
    state.isAuthenticated = false;
    const ok = await authenticateWithKey(apiKey, state);
    if (!ok) throw new Error('GRVT re-authentication failed after 401');
    return authenticatedRequestWithState(state, apiKey, url, body, options);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as { result?: unknown; [k: string]: unknown };
  return data.result ?? data;
}

export default {
  authenticateGRVT,
  authenticatedRequest,
  publicRequest,
  getAuthStatus,
  logout,
  authenticateWithKey,
  authenticatedRequestWithState,
  createEmptyAuthState,
};
