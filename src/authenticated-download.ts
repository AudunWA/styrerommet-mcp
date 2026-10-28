/** Never send service credentials to a caller-supplied host or cross-origin redirect. */
export async function fetchAuthenticatedDownload(
  value: string,
  origin: string,
  headers: Record<string, string>,
): Promise<Response> {
  let url = new URL(value, origin);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.origin !== origin || url.username || url.password) {
      throw new Error(`Authenticated downloads must use ${origin}`);
    }
    const response = await fetch(url.href, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Download redirect has no location");
    url = new URL(location, url);
  }
  throw new Error("Too many download redirects");
}
