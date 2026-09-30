// La radio del gremio: el botón de hablar y lo último que se ha dicho (075).
//
// EL BOTÓN FLOTA, SE MUEVE Y LATE. Las tres cosas vienen de usarlo de verdad:
//
//   - FLOTA porque antes era un rectángulo dentro de una tarjeta y subía y
//     bajaba según cuántos mensajes hubiera en la lista. Había que BUSCARLO con
//     la vista antes de apretar, que es lo que no se puede hacer conduciendo
//     (P75-06).
//   - SE MUEVE porque el sitio bueno no es el mismo para todos: depende de la
//     mano, del soporte del teléfono y de lo que tape debajo. Se arrastra por
//     su asidero y se queda donde lo dejes, también la próxima vez.
//   - LATE porque un botón redondo sobre un mapa oscuro no se ve si no se
//     mueve. El pulso dice «estoy aquí» sin ocupar sitio ni pedir nada.
//
// ARRASTRAR TIENE SU PROPIO ASIDERO, y es a propósito. Apretar el círculo es
// hablar; si el arrastre fuera también sobre el círculo habría que adivinar,
// cada vez que un dedo se mueve un poco, si quería hablar o mover — y esa
// adivinanza se equivoca justo cuando el coche pega un bote.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MensajeRadio } from './api';
import type { EstadoBoton } from './radio';

const LADO = 84;
const MARGEN = 12;
const CLAVE_POSICION = 'radio:posicion';

interface Punto { x: number; y: number }
interface Caja { x: number; y: number; ancho: number; alto: number }

// Respecto a QUÉ está colocado el botón.
//
// Un elemento fijo se coloca respecto a la ventana… salvo que algún antepasado
// tenga un `transform`, en cuyo caso se coloca respecto a ÉL. En la aplicación
// no lo hay y esto es la ventana; en la galería de diseños cada pantalla de
// teléfono sí lo tiene, para que lo fijo se quede dentro de su marco. Midiendo
// el contenedor de verdad en vez de dar por hecho la ventana, las dos
// situaciones salen bien con el mismo código —y es además lo correcto: lo que
// hay que hacer es no salirse del sitio donde uno está dibujado.
function cajaDe(elemento: HTMLElement | null): Caja {
  const padre = elemento?.offsetParent as HTMLElement | null | undefined;
  if (padre) {
    const r = padre.getBoundingClientRect();
    return { x: r.x, y: r.y, ancho: r.width, alto: r.height };
  }
  return { x: 0, y: 0, ancho: window.innerWidth, alto: window.innerHeight };
}

// Dentro del sitio, siempre. Sin esto, girar el teléfono o abrir el teclado
// puede dejar el botón fuera y no hay forma de recuperarlo.
function dentroDe(caja: Caja, { x, y }: Punto): Punto {
  const anchoMax = Math.max(MARGEN, caja.ancho - LADO - MARGEN);
  const altoMax = Math.max(MARGEN, caja.alto - LADO - MARGEN);
  return {
    x: Math.min(anchoMax, Math.max(MARGEN, x)),
    y: Math.min(altoMax, Math.max(MARGEN, y)),
  };
}

function posicionPorDefecto(caja: Caja): Punto {
  // Abajo a la derecha, donde cae el pulgar.
  return dentroDe(caja, {
    x: caja.ancho - LADO - MARGEN,
    y: caja.alto - LADO - 24,
  });
}

function posicionGuardada(caja: Caja): Punto {
  try {
    const crudo = localStorage.getItem(CLAVE_POSICION);
    if (crudo !== null) {
      const p = JSON.parse(crudo) as Partial<Punto>;
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return dentroDe(caja, { x: p.x, y: p.y });
      }
    }
  } catch {
    // Guardado ilegible o almacenamiento cerrado: a su sitio de siempre.
  }
  return posicionPorDefecto(caja);
}

interface Props {
  estado: EstadoBoton;
  encendida: boolean;
  puedeGrabar?: 'si' | 'sin_micro' | 'sin_grabadora';
  habla: string | null;
  quedan: number;
  segundosMax: number;
  mensajes: MensajeRadio[];
  aviso: string | null;
  oyentes: number | null;
  t: (clave: string, vars?: Record<string, string>) => string;
  alApretar: () => void;
  alSoltar: () => void;
  alVolverAOir: (mensajeId: number) => void;
}

function hace(creadoEn: string, t: Props['t']): string {
  const min = Math.floor((Date.now() - new Date(creadoEn).getTime()) / 60_000);
  if (min < 1) return t('radio.ahora');
  return t('radio.hace', { min: String(min) });
}

export default function PanelRadio({
  estado, encendida, puedeGrabar = 'si', habla, quedan, segundosMax, mensajes,
  aviso, oyentes, t, alApretar, alSoltar, alVolverAOir,
}: Props) {
  const [listaAbierta, setListaAbierta] = useState(false);
  // Se parte de la ventana, que es lo correcto en la aplicación, y se corrige
  // al montar con el contenedor de verdad. En la aplicación no cambia nada; en
  // la galería, cada botón se coloca dentro de su marco.
  const [pos, setPos] = useState<Punto>(() => posicionGuardada(cajaDe(null)));
  const [moviendo, setMoviendo] = useState(false);
  const arrastre = useRef<{ dx: number; dy: number } | null>(null);
  const caja = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const recolocar = () => setPos((p) => dentroDe(cajaDe(caja.current), p));
    recolocar();
    window.addEventListener('resize', recolocar);
    window.addEventListener('orientationchange', recolocar);
    return () => {
      window.removeEventListener('resize', recolocar);
      window.removeEventListener('orientationchange', recolocar);
    };
  }, []);

  const empezarAMover = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // Capturar el puntero es lo que hace que el botón siga al dedo aunque se
      // salga del asidero. Si el navegador no deja, se mueve igual mientras el
      // dedo no se salga: lo que no puede pasar es que un fallo aquí deje el
      // botón sin poder moverse nunca.
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // Sin captura, pero moviéndose.
    }
    const c = cajaDe(caja.current);
    // El dedo puede agarrar el asidero por cualquier punto: se guarda por dónde
    // lo cogió para que el botón no pegue un salto al empezar a moverse.
    arrastre.current = { dx: e.clientX - (c.x + pos.x), dy: e.clientY - (c.y + pos.y) };
    setMoviendo(true);
  }, [pos]);

  const mover = useCallback((e: React.PointerEvent) => {
    const a = arrastre.current;
    if (a === null) return;
    const c = cajaDe(caja.current);
    setPos(dentroDe(c, { x: e.clientX - c.x - a.dx, y: e.clientY - c.y - a.dy }));
  }, []);

  const dejarDeMover = useCallback(() => {
    if (arrastre.current === null) return;
    arrastre.current = null;
    setMoviendo(false);
    // Donde lo dejaste es donde estará mañana: en el asiento de un taxi, volver
    // a colocarlo cada día sería motivo suficiente para dejar de usarlo.
    setPos((p) => {
      try {
        localStorage.setItem(CLAVE_POSICION, JSON.stringify(p));
      } catch {
        // Almacenamiento cerrado (navegación privada): se queda por esta vez.
      }
      return p;
    });
  }, []);

  if (!encendida) return null;

  const hablando = estado === 'hablando';
  const ocupado = estado === 'ocupado';
  const esperando = estado === 'pidiendo' || estado === 'enviando';
  const ultimo = mensajes[0];
  // De qué lado está, para que lo que se pinta encima salga hacia dentro de la
  // pantalla y no se corte contra el borde.
  const lado = pos.x + LADO / 2 > cajaDe(caja.current).ancho / 2 ? 'derecha' : 'izquierda';

  // Un teléfono que no puede grabar se dice ANTES de que alguien apriete, no
  // después de fallar: el botón sigue estando para escuchar y volver a oír, y
  // lo que cambia es que no promete algo que no va a pasar.
  const mudo = puedeGrabar !== 'si';

  const rotulo = mudo
    ? t('radio.soloEscuchar')
    : hablando
    ? t('radio.hablando', { seg: String(quedan) })
    : estado === 'enviando' ? t('radio.enviando')
      : estado === 'pidiendo' ? t('radio.pidiendo')
        : ocupado
          ? (habla ? t('radio.ocupado', { nombre: habla }) : t('radio.ocupadoSinNombre'))
          : t('radio.apretar');

  // Lo que se dice encima del botón, por orden de urgencia: un aviso manda sobre
  // quién habla, y quién habla manda sobre a cuántos llegó lo último.
  const linea = aviso
    ?? (mudo ? t('radio.soloEscucharNota') : null)
    ?? (ocupado ? rotulo : null)
    ?? (oyentes !== null && oyentes > 0 ? t('radio.oyentes', { n: String(oyentes) }) : null);

  return (
    <>
      {listaAbierta && (
        <div className="radio-hoja">
          <div className="radio-cabecera">
            <h3>{t('radio.titulo')}</h3>
            {/* Que no suena con la pantalla apagada se dice, no se esconde: un
                taxista que lo descubra conduciendo ya no vuelve a confiar. */}
            <span className="radio-nota">{t('radio.noSuena')}</span>
          </div>
          {mensajes.length === 0 ? (
            <p className="radio-vacia">{t('radio.sinMensajes')}</p>
          ) : (
            <ul className="radio-lista">
              {mensajes.map((m) => (
                <li key={m.id} className={m.mio ? 'radio-mio' : undefined}>
                  <button
                    type="button"
                    onClick={() => alVolverAOir(m.id)}
                    title={t('radio.volverAOir')}
                  >
                    <span className="radio-play" aria-hidden="true">▶</span>
                    <span className="radio-quien">
                      {m.nombre}
                      {m.matricula !== null && <em> · {m.matricula}</em>}
                    </span>
                    <span className="radio-cuando">
                      {Math.round(m.duracionMs / 1000)}s · {hace(m.creadoEn, t)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        ref={caja}
        className={`radio-flotante${moviendo ? ' radio-moviendo' : ''}`}
        data-lado={lado}
        style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        aria-label={t('radio.titulo')}
      >
        <div className="radio-encima">
          {linea !== null && (
            <p className={`radio-linea${aviso !== null ? ' radio-linea-aviso' : ''}`}>{linea}</p>
          )}
          {ultimo !== undefined && (
            <button
              type="button"
              className="radio-ultimo"
              onClick={() => setListaAbierta((a) => !a)}
              aria-expanded={listaAbierta}
            >
              <span className="radio-play" aria-hidden="true">{listaAbierta ? '▾' : '▴'}</span>
              <span className="radio-quien">{ultimo.nombre}</span>
              <span className="radio-cuando">{hace(ultimo.creadoEn, t)}</span>
            </button>
          )}
        </div>

        <button
          type="button"
          className={`radio-boton${hablando ? ' radio-boton-hablando' : ''}`
            + `${ocupado ? ' radio-boton-ocupado' : ''}`
            + `${estado === 'libre' && !moviendo && !mudo ? ' radio-boton-late' : ''}`}
          // Puntero y no clic: hay que saber cuándo se aprieta y cuándo se
          // suelta. `onPointerLeave` y `onPointerCancel` también sueltan, porque
          // un dedo que resbala fuera del botón nunca manda el «arriba», y sin
          // eso el turno se quedaría pillado hasta caducar.
          onPointerDown={alApretar}
          onPointerUp={alSoltar}
          onPointerLeave={alSoltar}
          onPointerCancel={alSoltar}
          onContextMenu={(e) => e.preventDefault()}
          disabled={esperando || ocupado || mudo}
          aria-pressed={hablando}
          aria-label={rotulo}
          // El aro que se vacía marca lo que queda de turno. Se ve de reojo, sin
          // leer el número, que es lo único que sirve conduciendo.
          style={hablando
            ? { ['--queda' as string]: `${Math.round((quedan / Math.max(1, segundosMax)) * 100)}%` }
            : undefined}
        >
          <span className="radio-icono" aria-hidden="true">{hablando ? '🎙️' : '📢'}</span>
          {hablando && <span className="radio-segundos">{quedan}</span>}
        </button>

        {/* El asidero. Pequeño y en la esquina de arriba, fuera del camino del
            pulgar que aprieta para hablar. */}
        <button
          type="button"
          className="radio-asidero"
          onPointerDown={empezarAMover}
          onPointerMove={mover}
          onPointerUp={dejarDeMover}
          onPointerCancel={dejarDeMover}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t('radio.mover')}
          title={t('radio.mover')}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </div>
    </>
  );
}
