import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './estilos.css';

// La galería de diseños se abre con ?galeria y llega en su propio trozo: no
// pesa nada para quien solo quiere pedir un taxi.
const Galeria = lazy(() => import('./Galeria'));
const enGaleria = new URLSearchParams(window.location.search).has('galeria');

// Service worker: hace que la aplicación abra sin cobertura. Se registra
// después de pintar para no competir por la red con lo que el usuario está
// esperando ver.
//
// La versión nueva toma el mando en cuanto está lista (`skipWaiting` en el
// service worker), pero la PÁGINA no se recarga a media faena: se recarga la
// próxima vez que se vuelve a la aplicación, que es un momento en el que nadie
// está haciendo nada.
//
// Antes no se forzaba nada, con el argumento de que la versión nueva entraría
// «al siguiente arranque». En una aplicación instalada no hay siguiente
// arranque —no se cierra nunca del todo— y un teléfono se quedaba ejecutando el
// JavaScript de hace días: se persiguió durante días un fallo que ya estaba
// corregido, porque el arreglo no había llegado al aparato.
if ('serviceWorker' in navigator && !enGaleria) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la aplicación funciona igual: solo deja de abrir
      // sin red. No es motivo para romper nada.
    });
  });

  let hayVersionNueva = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    hayVersionNueva = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (hayVersionNueva && document.visibilityState === 'visible') {
      hayVersionNueva = false;
      window.location.reload();
    }
  });
}

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    {enGaleria ? (
      <Suspense fallback={<div className="cargando">Cargando diseños…</div>}>
        <Galeria />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
