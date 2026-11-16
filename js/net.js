// Netzabfragen mit Zeitlimit: Antwortet ein Dienst nicht, soll die App nicht endlos warten.

/**
 * Wie fetch(), bricht aber nach `timeoutMs` ab. Ein Abbruch durch das eigene Zeitlimit kommt als
 * Fehler mit name 'TimeoutError' an – ein Abbruch von außen (signal) weiterhin als 'AbortError'.
 */
export async function fetchWithTimeout(url, { signal, timeoutMs = 12000, ...options } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort();
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      const timeout = new Error('Der Dienst antwortet nicht.');
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
