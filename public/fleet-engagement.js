// The footer collects only a consented email; formula contents never enter it.
if (location.origin === 'https://formula.significanthobbies.com' && !document.querySelector('saas-maker-newsletter-capture')) {
  const extension = document.querySelector('fleet-footer-extension') || document.createElement('fleet-footer-extension');
  const capture = document.createElement('saas-maker-newsletter-capture');
  for (const [name, value] of Object.entries({
    slot: 'capture',
    'catalog-id': 'nutrition-formula-engine',
    'project-key': 'pk_5b45747d605d3b4ecc0ed1e7fb7d03560fc76204570345a2',
    'product-name': 'Formula Composition Engine',
    kind: 'newsletter',
    'allow-kind-selection': '',
    source: 'fleet-footer',
    'privacy-url': 'https://sassmaker.com/privacy',
    theme: 'light',
  })) capture.setAttribute(name, value);
  extension.append(capture);
  if (!extension.isConnected) document.body.append(extension);
  const loader = document.createElement('script');
  loader.type = 'module';
  loader.src = 'https://sassmaker.com/newsletter-capture.js';
  document.head.append(loader);
}
