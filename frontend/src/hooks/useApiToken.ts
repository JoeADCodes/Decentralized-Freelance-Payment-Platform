/**
 * useApiToken.ts
 *
 * Wallet JWT for the authenticated read routes (the notification feed).
 *
 * Pages that POST something get their token inside the submit handler, because
 * a token is only needed at the moment of the write. A feed is different: it is
 * fetched as soon as the page opens, so the token has to be requested up front
 * and the page has to distinguish "no wallet yet" from "authenticating" from
 * "authentication failed".
 *
 * The backend's tokens are short-lived, so an expired one is not retried here —
 * reconnecting the wallet is the recovery path, and `refresh` re-runs the
 * challenge for a caller that wants to force it.
 */

import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../lib/api";
import { useWallet } from "./wallet-context";

export interface ApiTokenState {
  /** Bearer token for the connected wallet, or `null` until it is issued. */
  token: string | null;
  loading: boolean;
  error: string | null;
  /** Re-run the challenge-response flow for the current wallet. */
  refresh: () => void;
}

export function useApiToken(): ApiTokenState {
  const { publicKey, signMessage } = useWallet();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!publicKey) {
      // Disconnecting must drop the token: it is only valid for that wallet.
      setToken(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    authenticate(publicKey, signMessage)
      .then((issued) => {
        if (!cancelled) setToken(issued);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey, signMessage, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  return { token, loading, error, refresh };
}
