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
// No se fuerza a que la versión nueva tome el mando de inmediato: si alguien
// está en mitad de un viaje, cambiarle el código bajo los pies es peor que
// dejarle terminar con la versión que ya tenía cargada. Entra al siguiente
// arranque, que en un teléfono es cuestión de minutos.
if ('serviceWorker' in navigator && !enGaleria) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la aplicación funciona igual: solo deja de abrir
      // sin red. No es motivo para romper nada.
    });
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
