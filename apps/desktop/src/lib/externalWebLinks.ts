export function externalWebUrlFromTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) {
    return undefined;
  }

  // PDF.js uses fragment/empty hrefs and an onclick handler for destinations
  // inside the current document. Reading `anchor.href` here would expand those
  // values to the WebView's own HTTP URL and misclassify them as web links.
  if (anchor.closest("[data-internal-link]")) {
    return undefined;
  }
  return normalizeExternalWebUrl(anchor.getAttribute("href") ?? "");
}

export function normalizeExternalWebUrl(href: string): string | undefined {
  const candidate = href.trim();
  // An embedded local PDF has no meaningful web base URL. Requiring an
  // absolute URL also ensures PDF fragments can never become WebView URLs.
  if (!/^https?:\/\//i.test(candidate)) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
