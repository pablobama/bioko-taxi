// Plano de Malabo, dibujado en SVG con proyección propia.
//
// Las calles vienen de src/mapa-malabo.json, generado por
// scripts/compilar-mapa.mjs a partir de OpenStreetMap. Consecuencias:
//   - Se descarga UNA vez, con la app, y queda cacheado como cualquier otro
//     recurso del paquete.
//   - Funciona sin conexión: no hay ninguna petición de mapa en ejecución.
//   - No hay librería de mapas: el plano son unos cuantos `path` de SVG y la
//     cámara es un `transform`. Mover el mapa cuesta un atributo, no un
//     redibujado, que es lo que lo hace viable en un Android de gama baja.
//
// La cámara encuadra lo que importa en cada momento (ver `Encuadre`): antes de
// pedir, dónde está la persona; con taxi asignado, el coche y su recorrido
// hasta la recogida; ya a bordo, el trayecto hasta el destino.
//
// Licencia: datos de OpenStreetMap (ODbL). La atribución es obligatoria y está
// abajo a la derecha del plano.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PuntoMapa } from './api';
import { estiloCategoria } from './categorias';
import {
  aPantalla, construirTrazados, crearProyeccion, encuadrar, transformacion,
  TEMA_MAPA, type Camara, type Plano, type Proyeccion, type Punto2D, type Trazados,
} from './proyeccion';
import { calcularRuta, type Punto } from './rutas';

export interface Marca {
  lat: number;
  lng: number;
  nombre: string;
}

// Qué tiene que caber en pantalla. Lo decide quien usa el mapa, porque depende
// de la fase del viaje y no de la geometría.
export type Encuadre =
  // Dónde está la persona: su barrio. Antes de pedir y mientras busca taxi.
  | 'persona'
  // El coche viniendo a por ella, con el recorrido que le queda.
  | 'recogida'
  // El trayecto del viaje, ya a bordo.
  | 'viaje';

export interface PropiedadesMapa {
  puntos: PuntoMapa[];
  origen?: Marca | null;
  destino?: Marca | null;
  taxi?: { lat: number; lng: number } | null;
  buscando?: boolean;
  encuadre?: Encuadre;
  // Paradas del taxi compartido: solo el lugar, nunca de quién es.
  paradas?: Array<{ lat: number; lng: number; esTuya: boolean }>;
}

// El plano se prepara una sola vez para toda la vida de la aplicación: son
// ~3.700 vías que hay que proyectar y convertir en cadenas de `path`.
type PlanoListo = { plano: Plano; proy: Proyeccion; trazados: Trazados };
let planoCompartido: PlanoListo | null = null;
let cargando: Promise<PlanoListo> | null = null;

function prepararPlano(): Promise<PlanoListo> {
  if (planoCompartido) return Promise.resolve(planoCompartido);
  if (!cargando) {
    cargando = import('./mapa-malabo.json').then((modulo) => {
      const plano = (modulo.default ?? modulo) as unknown as Plano;
      const proy = crearProyeccion(plano.recuadro);
      planoCompartido = { plano, proy, trazados: construirTrazados(plano, proy) };
      return planoCompartido;
    });
  }
  return cargando;
}

// Prioridad del pin cuando dos se pisan: en un plano de ciudad importa más
// saber dónde está el hospital que dónde está el enésimo restaurante.
const PRIORIDAD: Record<string, number> = {
  mercado: 1, hospital: 1, transporte: 1,
  iglesia: 2, farmacia: 2, escuela: 2, gasolinera: 2, plaza: 2, deporte: 2,
  gobierno: 3, hotel: 3, banco: 3,
  restaurante: 4, zona: 5,
};

export default function Mapa({
  puntos, origen, destino, taxi, buscando, encuadre = 'persona', paradas,
}: PropiedadesMapa) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [caja, setCaja] = useState({ ancho: 0, alto: 0 });
  const [listo, setListo] = useState<PlanoListo | null>(planoCompartido);
  const [rutaTaxi, setRutaTaxi] = useState<Punto[] | null>(null);
  const [rutaViaje, setRutaViaje] = useState<Punto[] | null>(null);

  useEffect(() => {
    if (listo) return;
    let vivo = true;
    void prepararPlano().then((p) => { if (vivo) setListo(p); });
    return () => { vivo = false; };
  }, [listo]);

  // Tamaño real del hueco: el SVG se dibuja en píxeles de pantalla, así que la
  // cámara necesita saber cuántos hay.
  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const medir = () => setCaja({ ancho: el.clientWidth, alto: el.clientHeight });
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  // El coche hacia el punto de recogida. Se recalcula solo cuando se ha movido
  // lo bastante: cada lectura de GPS no cambia la ruta, y recalcularla a cada
  // paso gastaría batería sin cambiar nada en pantalla.
  const ultimoCalculoTaxi = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (!taxi || !origen) {
      setRutaTaxi(null);
      ultimoCalculoTaxi.current = null;
      return;
    }
    // ~22 m: suficiente para que la ruta siga al coche calle a calle ahora
    // que el GPS del taxista llega en continuo, sin recalcular con el baile
    // de un GPS parado. El cálculo en sí es barato (milisegundos).
    const previo = ultimoCalculoTaxi.current;
    const movido = previo === null
      || Math.abs(previo.lat - taxi.lat) > 0.0002
      || Math.abs(previo.lng - taxi.lng) > 0.0002;
    if (!movido) return;
    ultimoCalculoTaxi.current = { lat: taxi.lat, lng: taxi.lng };

    let vivo = true;
    void calcularRuta(taxi, origen).then((ruta) => {
      if (vivo) setRutaTaxi(ruta ? ruta.puntos : null);
    });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxi?.lat, taxi?.lng, origen?.lat, origen?.lng]);

  // El trayecto pedido: origen → destino. Solo cambia al cambiar el viaje.
  useEffect(() => {
    if (!origen || !destino) {
      setRutaViaje(null);
      return;
    }
    let vivo = true;
    void calcularRuta(origen, destino).then((ruta) => {
      if (vivo) setRutaViaje(ruta ? ruta.puntos : null);
    });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origen?.lat, origen?.lng, destino?.lat, destino?.lng]);

  const { ancho, alto } = caja;

  // --- Cámara -------------------------------------------------------------
  const camara: Camara | null = useMemo(() => {
    if (!listo || ancho === 0 || alto === 0) return null;
    const { aMundo } = listo.proy;
    const enfoque: Punto2D[] = [];

    if (origen) enfoque.push(aMundo(origen.lat, origen.lng));
    // El coche entra en el encuadre siempre que se vea: si está en pantalla,
    // tiene que caber. Es lo que hace que al aceptar la carrera el mapa se
    // abra de golpe para mostrar dónde viene.
    if (taxi) enfoque.push(aMundo(taxi.lat, taxi.lng));

    if (encuadre === 'recogida') {
      // La ruta entera, no solo sus extremos: así no se sale de pantalla la
      // curva que da el coche para llegar.
      for (const p of rutaTaxi ?? []) enfoque.push(aMundo(p.lat, p.lng));
    } else if (encuadre === 'viaje') {
      if (destino) enfoque.push(aMundo(destino.lat, destino.lng));
      for (const p of rutaViaje ?? []) enfoque.push(aMundo(p.lat, p.lng));
      for (const p of paradas ?? []) enfoque.push(aMundo(p.lat, p.lng));
    }

    const ajustado = encuadrar(enfoque, ancho, alto, listo.proy, {
      margen: Math.min(52, Math.max(24, Math.round(ancho * 0.11))),
      // Encuadrando a una sola persona no hace falta ver medio Malabo.
      metrosMinimos: encuadre === 'persona' ? 700 : 420,
    });
    if (ajustado) return ajustado;

    // Sin nada que encuadrar (ni GPS ni referencia): el centro de Malabo.
    const { recuadro } = listo.plano;
    const centro = aMundo(
      (recuadro.sur + recuadro.norte) / 2,
      (recuadro.oeste + recuadro.este) / 2,
    );
    return {
      cx: centro[0],
      cy: centro[1],
      escala: ancho / (5_000 * listo.proy.unidadesPorMetro),
    };
  }, [listo, ancho, alto, origen, destino, taxi, encuadre, rutaTaxi, rutaViaje, paradas]);

  const pantalla = (lat: number, lng: number): Punto2D =>
    aPantalla(listo!.proy.aMundo(lat, lng), camara!, ancho, alto);

  // --- Pines de categoría --------------------------------------------------
  // Solo los que caben sin pisarse. Con un catálogo de cientos de sitios,
  // dibujarlos todos sería una mancha ilegible.
  const pines = useMemo(() => {
    if (!listo || !camara) return [];
    const conPantalla = puntos
      .map((p) => ({ punto: p, xy: aPantalla(listo.proy.aMundo(p.lat, p.lng), camara, ancho, alto) }))
      .filter(({ xy }) => xy[0] > 20 && xy[0] < ancho - 20 && xy[1] > 26 && xy[1] < alto - 20)
      .sort((a, b) => (PRIORIDAD[a.punto.categoria] ?? 6) - (PRIORIDAD[b.punto.categoria] ?? 6));

    const puestos: Punto2D[] = [];
    const tope = encuadre === 'persona' ? 9 : 5;
    const elegidos = [];
    for (const candidato of conPantalla) {
      if (elegidos.length >= tope) break;
      const pisa = puestos.some(
        (q) => Math.abs(q[0] - candidato.xy[0]) < 34 && Math.abs(q[1] - candidato.xy[1]) < 26,
      );
      if (pisa) continue;
      puestos.push(candidato.xy);
      elegidos.push(candidato);
    }
    return elegidos;
  }, [listo, camara, puntos, ancho, alto, encuadre]);

  // --- Rutas dibujadas ----------------------------------------------------
  // Con FUNDA: un trazo oscuro más ancho por debajo del de color. Es lo que
  // hacen los mapas de verdad, y es lo que garantiza que la ruta se vea cruce
  // por encima de una avenida clara o de una manzana vacía.
  const trazoRuta = (
    clave: string,
    ruta: Punto[] | null,
    extremos: [Marca | { lat: number; lng: number }, Marca] | null,
    color: string,
    grosor: number,
  ) => {
    let puntosRuta: Punto[] | null = ruta;
    let discontinua = false;
    if (!puntosRuta || puntosRuta.length < 2) {
      // Sin camino calculado (o todavía calculándose) se dibuja la línea recta
      // a trazos: nunca se deja al usuario sin ninguna referencia visual.
      if (!extremos) return null;
      puntosRuta = [extremos[0], extremos[1]];
      discontinua = true;
    }
    const d = puntosRuta
      .map((p, i) => {
        const xy = pantalla(p.lat, p.lng);
        return `${i === 0 ? 'M' : 'L'}${xy[0].toFixed(1)} ${xy[1].toFixed(1)}`;
      })
      .join('');
    const ancho2 = discontinua ? grosor * 0.6 : grosor;
    return (
      <g key={clave}>
        <path
          d={d}
          fill="none"
          stroke="#08080a"
          strokeWidth={ancho2 + 6}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.95}
        />
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={ancho2}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={discontinua ? '7 8' : undefined}
        />
      </g>
    );
  };

  // Rumbo del coche: hacia el siguiente punto de su ruta, o hacia la recogida
  // si todavía no hay ruta calculada.
  const rumboTaxi = (): number => {
    if (!taxi) return 0;
    const siguiente = rutaTaxi && rutaTaxi.length > 1 ? rutaTaxi[1] : origen;
    if (!siguiente) return 0;
    const a = pantalla(taxi.lat, taxi.lng);
    const b = pantalla(siguiente.lat, siguiente.lng);
    return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  };

  const hayPlano = listo !== null && camara !== null && ancho > 0 && alto > 0;

  return (
    <div ref={contenedor} className="mapa-svg" data-vias={listo?.plano.vias.length ?? 0}>
      {hayPlano ? (
        <svg
          viewBox={`0 0 ${ancho} ${alto}`}
          width={ancho}
          height={alto}
          role="img"
          aria-label="Plano de Malabo"
        >
          {/* El plano, en coordenadas de mundo: un solo `transform` lo mueve
              todo. `vector-effect` mantiene el grosor de las calles al hacer
              zoom, que es lo que evita que se conviertan en manchas. */}
          <g transform={transformacion(camara!, ancho, alto)}>
            <rect x={-9e4} y={-9e4} width={18e4} height={18e4} fill={TEMA_MAPA.tierra} />
            <path d={listo!.trazados.mar} fill={TEMA_MAPA.mar} />
            <path
              d={listo!.trazados.costa}
              fill="none"
              stroke={TEMA_MAPA.costa}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            {[4, 3, 2, 1].map((clase) => (
              <path
                key={clase}
                d={listo!.trazados.porClase[clase]}
                fill="none"
                stroke={TEMA_MAPA.vias[clase].color}
                strokeWidth={TEMA_MAPA.vias[clase].grosor}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>

          {/* Pines de sitios conocidos: caja con la sigla de su categoría y un
              triángulo que apunta al punto exacto. */}
          {pines.map(({ punto, xy }) => {
            const { icono, relleno, color } = estiloCategoria(punto.categoria);
            return (
              <g
                key={punto.id}
                transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}
                opacity={encuadre === 'persona' ? 1 : 0.6}
              >
                <path d="M0 3 L-3.4 -1 L3.4 -1 Z" fill={color} opacity={0.9} />
                <rect x={-11} y={-21} width={22} height={20} rx={6} fill="#0c0c0f" stroke={color} strokeWidth={1.4} />
                {/* El dibujo viene en rejilla de 24 y aquí cabe en 14: se
                    coloca la esquina en (-7,-18) y se escala. El grosor del
                    trazo se compensa para que no adelgace al encoger. */}
                <g transform="translate(-7,-18) scale(0.583)">
                  <path
                    d={icono}
                    fill={relleno ? color : 'none'}
                    stroke={relleno ? 'none' : color}
                    strokeWidth={3.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              </g>
            );
          })}

          {/* Rutas. En cada fase importa una sola: la del coche viniendo, o la
              del viaje. Dibujar las dos a la vez sería ruido. */}
          {encuadre === 'recogida' && taxi && origen
            && trazoRuta('recogida', rutaTaxi, [taxi, origen], '#ffb020', 5)}
          {encuadre !== 'recogida' && origen && destino
            && trazoRuta(
              'viaje',
              rutaViaje,
              [origen, destino],
              encuadre === 'viaje' ? '#ffb020' : '#f7f5f2',
              encuadre === 'viaje' ? 5 : 3.5,
            )}

          {/* Paradas del taxi compartido: numeradas, la propia en ámbar. */}
          {encuadre === 'viaje' && (paradas ?? []).map((parada, i) => {
            const xy = pantalla(parada.lat, parada.lng);
            return (
              <g key={`parada-${i}`} transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                <circle
                  r={8.5}
                  fill="#0a0a0b"
                  stroke={parada.esTuya ? '#ffb020' : 'rgba(247,245,242,.45)'}
                  strokeWidth={parada.esTuya ? 2.2 : 1.4}
                />
                <text
                  y={3.2}
                  textAnchor="middle"
                  fill={parada.esTuya ? '#ffb020' : 'rgba(247,245,242,.6)'}
                  className="parada-numero"
                >
                  {i + 1}
                </text>
              </g>
            );
          })}

          {/* Destino: cuadrado blanco. */}
          {destino && (() => {
            const xy = pantalla(destino.lat, destino.lng);
            return (
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                <rect x={-9} y={-9} width={18} height={18} rx={3} fill="#0a0a0b" />
                <rect x={-6} y={-6} width={12} height={12} rx={2} fill="#f7f5f2" />
              </g>
            );
          })()}

          {/* Origen: punto ámbar con anillo. Mientras se busca taxi, late. */}
          {origen && (() => {
            const xy = pantalla(origen.lat, origen.lng);
            return (
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                {buscando && <circle r={26} fill="#ffb020" className="pulso-origen" />}
                <circle r={9} fill="#0a0a0b" />
                <circle r={6.5} fill="#ffb020" />
                <circle r={12} fill="none" stroke="#ffb020" strokeWidth={1.5} opacity={0.5} />
              </g>
            );
          })()}

          {/* El coche, orientado según su rumbo. Desaparece en cuanto el
              pasajero sube: a partir de ahí su posición no es asunto de nadie
              (por eso quien usa el mapa deja de pasar `taxi`). */}
          {taxi && (() => {
            const xy = pantalla(taxi.lat, taxi.lng);
            return (
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)}) rotate(${rumboTaxi().toFixed(1)})`}>
                <rect x={-11} y={-7.5} width={22} height={15} rx={5} fill="#08080a" />
                <rect x={-9} y={-6} width={18} height={12} rx={4} fill="#ffb020" />
                <rect x={1} y={-3.5} width={5} height={7} rx={1.5} fill="#1a1206" opacity={0.55} />
              </g>
            );
          })()}
        </svg>
      ) : (
        <p className="mapa-cargando">Cargando el plano de Malabo…</p>
      )}
      <span className="mapa-atribucion">Calles © OpenStreetMap</span>
    </div>
  );
}
