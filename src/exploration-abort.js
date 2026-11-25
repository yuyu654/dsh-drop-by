// Stop waiting even when a provider fails to honor a cancellation signal.
export async function abortable(start, signal) {
  if (!signal) return start();
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    }), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

