// Optional remote integrations must never hold up the application's load event.
export function afterPageLoad(callback, pageWindow = window, pageDocument = document) {
  if (pageDocument.readyState === "complete") {
    pageWindow.setTimeout(callback, 0);
  } else {
    pageWindow.addEventListener("load", () => pageWindow.setTimeout(callback, 0), { once: true });
  }
}

export function loadDeferredScripts(pageDocument = document) {
  for (const placeholder of pageDocument.querySelectorAll("script[data-after-load-src]")) {
    const script = pageDocument.createElement("script");
    // Preserve the original deferred scripts' execution order.
    script.async = false;
    for (const { name, value } of placeholder.attributes) {
      if (!["type", "defer", "data-after-load-src"].includes(name)) {
        script.setAttribute(name, value);
      }
    }
    script.src = placeholder.getAttribute("data-after-load-src");
    placeholder.replaceWith(script);
  }
}
