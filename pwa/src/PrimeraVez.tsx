// La guía de la primera vez: un foco que recorre la pantalla.
//
// Se llama `PrimeraVez` y no `Guia` porque ya hay un `guia.ts` —la guía por
// VOZ del taxista— y en Windows dos ficheros que solo se distinguen por una
// mayúscula son el mismo fichero. Lo dijo el compilador, no una preferencia.
//
// Por qué un foco y no un texto de bienvenida. Un cartel con cinco párrafos se
// cierra sin leer —lo hace todo el mundo— y deja a la persona igual que
// estaba. El foco señala UNA cosa de la pantalla de verdad, dice para qué
// sirve en una línea, y la siguiente señala otra. Se aprende mirando dónde
// está el botón, que es lo que luego hay que recordar.
//
// Reglas que se ha impuesto:
//
//   · Se puede saltar SIEMPRE, y desde el primer paso. Una guía que no se
//     puede cerrar es un secuestro.
//   · El agujero deja pasar los toques: si alguien quiere pulsar lo que se le
//     está señalando, se le deja. La guía no bloquea la aplicación.
//   · Un paso cuyo elemento no está en pantalla se salta solo. Las pantallas
//     cambian con el estado —el botón de pedir no existe si no hay destino— y
//     señalar un hueco vacío es peor que no decir nada.
//   · Se recuerda que ya se vio, por papel y por versión. Cuando la guía
//     cambie de verdad, se sube la versión y se vuelve a enseñar una vez.

import { useEffect, useState } from 'react';

export interface PasoGuia {
  // A qué se apunta: un selector de la pantalla de verdad. Sin elemento, el
  // paso se salta.
  selector: string;
  titulo: string;
  texto: string;
}

export interface PropiedadesPrimeraVez {
  pasos: PasoGuia[];
  alTerminar: () => void;
  // Textos de los botones, que vienen de i18n.
  textoSiguiente: string;
  textoFin: string;
  textoSaltar: string;
}

interface Hueco { top: number; left: number; width: number; height: number }

const MARGEN = 8;

function huecoDe(selector: string): Hueco | null {
  const elemento = document.querySelector(selector);
  if (!elemento) return null;
  // Si lo que se va a señalar está fuera de la pantalla, primero se trae. Sin
  // esto el foco se dibujaba debajo del borde y el cartel se iba fuera: la
  // guía quedaba en una pantalla oscurecida y vacía. Pasó al probarlo.
  const antes = elemento.getBoundingClientRect();
  if (antes.bottom > window.innerHeight || antes.top < 0) {
    elemento.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  const r = elemento.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    top: r.top - MARGEN,
    left: r.left - MARGEN,
    width: r.width + MARGEN * 2,
    height: r.height + MARGEN * 2,
  };
}

export default function PrimeraVez({
  pasos, alTerminar, textoSiguiente, textoFin, textoSaltar,
}: PropiedadesPrimeraVez) {
  const [indice, setIndice] = useState(0);
  const [hueco, setHueco] = useState<Hueco | null>(null);
  // Los pasos que de verdad hay en pantalla AHORA, decididos al abrir. Si no,
  // el contador dice «4 de 5» en el primer paso que se enseña —porque los tres
  // de antes no existían en esa pantalla— y parece que la guía se ha saltado
  // sola lo importante.
  const [secuencia] = useState<PasoGuia[]>(
    () => pasos.filter((p) => document.querySelector(p.selector) !== null),
  );

  // El recuadro se vuelve a medir en cada paso y cuando la pantalla cambia de
  // tamaño o se desplaza: en un teléfono, girar el móvil mueve todo.
  useEffect(() => {
    const paso = secuencia[indice];
    if (!paso) return;
    const medir = () => setHueco(huecoDe(paso.selector));
    medir();
    // Una vuelta más tarde: si el elemento acaba de aparecer, la primera
    // medida sale a cero y el foco se queda en la esquina.
    const reloj = setTimeout(medir, 120);
    window.addEventListener('resize', medir);
    window.addEventListener('scroll', medir, true);
    return () => {
      clearTimeout(reloj);
      window.removeEventListener('resize', medir);
      window.removeEventListener('scroll', medir, true);
    };
  }, [indice, secuencia]);

  // Un paso sin elemento en pantalla no se enseña: se pasa al siguiente.
  useEffect(() => {
    if (indice >= secuencia.length) {
      alTerminar();
      return;
    }
    if (hueco === null && document.querySelector(secuencia[indice]?.selector ?? '') === null) {
      setIndice((i) => i + 1);
    }
  }, [indice, hueco, secuencia, alTerminar]);

  const paso = secuencia[indice];
  if (!paso || hueco === null) return null;

  const ultimo = indice === secuencia.length - 1;
  // El cartel va debajo del hueco, salvo que el hueco esté en la mitad de
  // abajo: entonces va encima. Si no, en un teléfono el texto se sale.
  const debajo = hueco.top + hueco.height < window.innerHeight * 0.55;

  return (
    <div className="guia">
      {/* Cuatro paños alrededor del hueco en vez de una máscara: el agujero es
          de verdad —los toques pasan— y no hace falta SVG ni filtros, que en
          un teléfono de gama baja cuestan. */}
      <div className="guia-pano" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hueco.top) }} />
      <div className="guia-pano" style={{ top: hueco.top + hueco.height, left: 0, right: 0, bottom: 0 }} />
      <div className="guia-pano" style={{ top: hueco.top, left: 0, width: Math.max(0, hueco.left), height: hueco.height }} />
      <div className="guia-pano" style={{ top: hueco.top, left: hueco.left + hueco.width, right: 0, height: hueco.height }} />
      <div
        className="guia-foco"
        style={{ top: hueco.top, left: hueco.left, width: hueco.width, height: hueco.height }}
      />

      <div
        className="guia-cartel"
        style={debajo
          // Sujeto dentro de la pantalla en los dos casos: con el hueco pegado
          // a un borde, el cartel se salía y no se leía nada.
          ? { top: Math.min(hueco.top + hueco.height + 14, window.innerHeight - 190) }
          : { bottom: Math.min(window.innerHeight - hueco.top + 14, window.innerHeight - 190) }}
      >
        <span className="guia-cuenta">{indice + 1} / {secuencia.length}</span>
        <h2>{paso.titulo}</h2>
        <p>{paso.texto}</p>
        <div className="guia-botones">
          <button type="button" className="tenue" onClick={alTerminar}>{textoSaltar}</button>
          <button
            type="button"
            className="principal"
            onClick={() => (ultimo ? alTerminar() : setIndice((i) => i + 1))}
          >
            {ultimo ? textoFin : textoSiguiente}
          </button>
        </div>
      </div>
    </div>
  );
}

// Si a este papel le toca ver la guía. La versión va en la clave: el día que
// la guía cambie de verdad se sube y se vuelve a enseñar una vez, sin tener
// que inventar otra bandera.
export function guiaPendiente(papel: string, version: number): boolean {
  try {
    return localStorage.getItem(`guia:${papel}:v${version}`) === null;
  } catch {
    // Sin almacenamiento —modo privado— la guía se enseña cada vez. Es mejor
    // que no enseñarla nunca, y es un caso raro.
    return true;
  }
}

export function marcarGuiaVista(papel: string, version: number): void {
  try {
    localStorage.setItem(`guia:${papel}:v${version}`, '1');
  } catch {
    // Da igual: como mucho se vuelve a ver.
  }
}
