// The one place in the frontend that imports @sentry/browser — mirrors
// internal/logger on the Go side. Every console.warn/error call site that
// should be reported to Sentry goes through logWarn/logError here instead
// of calling the SDK directly.
//
// Sentry is optional and off by default: initLogger no-ops when
// VITE_SENTRY_DSN is unset, which is every local dev build and any fork
// build without the release secret.
import * as Sentry from '@sentry/browser';

let sentryEnabled = false;

export function initLogger(release: string): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({ dsn, release });
  sentryEnabled = true;
}

export function logDebug(msg: string, ...args: unknown[]): void {
  console.debug(msg, ...args);
}

export function logInfo(msg: string, ...args: unknown[]): void {
  console.info(msg, ...args);
}

export function logWarn(msg: string, ...args: unknown[]): void {
  console.warn(msg, ...args);
  if (sentryEnabled) Sentry.captureMessage(msg, 'warning');
}

export function logError(msg: string, err?: unknown, ...args: unknown[]): void {
  console.error(msg, err, ...args);
  if (!sentryEnabled) return;
  if (err instanceof Error) {
    Sentry.captureException(err);
  } else {
    Sentry.captureMessage(msg, 'error');
  }
}
