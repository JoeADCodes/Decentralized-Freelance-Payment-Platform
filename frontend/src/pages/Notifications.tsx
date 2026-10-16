/**
 * Notifications.tsx
 *
 * The signed-in user's feed (issue #66): escrow and dispute events that happened
 * to them, newest first, with unread state.
 *
 * The rows are written by the indexer, not by this page, so the feed is the same
 * whether the browser was open when the event landed or not. The one thing the
 * page owns is read state: opening the page does not mark anything read (a user
 * may only want to glance at the badge), clicking a row's button does, and so
 * does "Mark all as read".
 *
 * Refreshing re-fetches rather than polling: the feed is a list the user chose to
 * look at, and `GET /api/notifications` costs two queries on every call.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from "../lib/api";
import type { NotificationApi } from "../lib/api";
import { formatRelativeTime } from "../lib/time";
import { useApiToken } from "../hooks/useApiToken";
import { useWallet } from "../hooks/wallet-context";

export default function Notifications() {
  const { publicKey, connect, connecting } = useWallet();
  const { token, loading: authLoading, error: authError, refresh } = useApiToken();

  const [notifications, setNotifications] = useState<NotificationApi[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    fetchNotifications(token, controller.signal)
      .then((feed) => {
        setNotifications(feed.notifications);
        setUnread(feed.unread);
      })
      .catch((e: unknown) => {
        // A superseded request is not a failure to report.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [token, reload]);

  const markRead = useCallback(
    async (notification: NotificationApi) => {
      if (!token || notification.readAt) return;
      try {
        await markNotificationRead(notification.id, token);
        // Local update rather than a re-fetch: the feed is already on screen and
        // one row changed.
        setNotifications((rows) =>
          rows.map((row) =>
            row.id === notification.id ? { ...row, readAt: new Date().toISOString() } : row,
          ),
        );
        setUnread((count) => (count > 0 ? count - 1 : 0));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [token],
  );

  const markAllRead = useCallback(async () => {
    if (!token) return;
    try {
      const updated = await markAllNotificationsRead(token);
      if (updated > 0) setReload((n) => n + 1);
      setUnread(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  const busy = authLoading || loading;

  return (
    <Layout>
      <h1>Notifications</h1>

      {!publicKey ? (
        <p>
          <button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect your Freighter wallet"}
          </button>{" "}
          to see your notifications.
        </p>
      ) : (
        <p className="muted">
          For <code>{publicKey}</code> ·{" "}
          {unread > 0 ? (
            <>
              <strong>{unread}</strong> unread
            </>
          ) : (
            "Nothing unread"
          )}
        </p>
      )}

      {(authError ?? error) && (
        <p role="alert" className="alert alert-error">
          {authError ?? error}
        </p>
      )}

      {publicKey && (
        <p>
          <button onClick={() => setReload((n) => n + 1)} disabled={busy}>
            Refresh
          </button>{" "}
          <button onClick={() => void markAllRead()} disabled={!token || unread === 0}>
            Mark all as read
          </button>
        </p>
      )}

      {busy && notifications.length === 0 && publicKey && <p>Loading notifications…</p>}

      {publicKey && !busy && !authError && !error && notifications.length === 0 && (
        <p className="muted">No notifications yet.</p>
      )}

      {authError && (
        <p>
          <button onClick={refresh}>Try again</button>
        </p>
      )}

      {notifications.length > 0 && (
        <ul className="notification-list">
          {notifications.map((notification) => (
            <li
              key={notification.id}
              className={notification.readAt ? undefined : "notification-unread"}
            >
              <strong>{notification.title}</strong>{" "}
              <span className="muted">{formatRelativeTime(notification.createdAt, Date.now())}</span>
              {notification.body && <p className="notification-body">{notification.body}</p>}
              <p className="notification-actions">
                {notification.escrowId !== null ? (
                  <Link to={`/jobs/${notification.escrowId}`}>Open job #{notification.escrowId}</Link>
                ) : (
                  <span className="muted">Job not linked yet</span>
                )}{" "}
                {notification.readAt === null ? (
                  <button onClick={() => void markRead(notification)}>Mark as read</button>
                ) : (
                  <span className="muted">Read</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
