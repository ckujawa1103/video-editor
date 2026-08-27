/**
 * Keeping a render alive on a phone.
 *
 * Android is free to freeze or discard a background tab, and a browser page has
 * no way to demand otherwise — so the honest approach is to remove the reasons
 * it happens rather than to pretend it cannot. Hold a screen wake lock so the
 * display does not sleep mid-render (a sleeping screen is what gets a tab
 * dropped), re-take it when the user comes back, and warn before a navigation
 * throws away work in progress.
 */
export function createKeepAlive({ onStateChange = () => {} } = {}) {
  let sentinel = null;
  let wanted = false;

  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  async function acquire() {
    if (!supported || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        onStateChange(held());
      });
      onStateChange(held());
    } catch {
      // Denied (low battery, policy) — the render still runs, it just is not
      // protected from the screen going off.
      sentinel = null;
    }
  }

  async function release() {
    const s = sentinel;
    sentinel = null;
    try {
      await s?.release();
    } catch {
      /* already gone */
    }
    onStateChange(held());
  }

  // A wake lock is dropped whenever the page is hidden and must be re-taken.
  const onVisibility = () => {
    if (wanted && document.visibilityState === 'visible') acquire();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  const beforeUnload = (e) => {
    if (!wanted) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  };
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload);

  function held() {
    return sentinel !== null;
  }

  return {
    supported,
    held,
    /** Call when a render starts. */
    async start() {
      wanted = true;
      await acquire();
    },
    /** Call when it finishes, fails, or is cancelled. */
    async stop() {
      wanted = false;
      await release();
    },
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', beforeUnload);
    },
  };
}
