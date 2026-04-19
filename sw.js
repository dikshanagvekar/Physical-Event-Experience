/**
 * sw.js — Service Worker for PWA offline support
 */

const CACHE_NAME = 'venue-ai-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/crowd.js',
  '/gemini.js',
  '/manifest.json',
  '/data/venue.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Cache-first for static assets, network-first for API calls
  const isAPI = event.request.url.includes('generativelanguage.googleapis.com');

  if (isAPI) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});
