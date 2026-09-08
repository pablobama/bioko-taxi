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
  | 'viaje'
  // Todo lo que anduvo un taxi en un periodo. Solo lo usa el operador.
  | 'recorrido';

export interface PropiedadesMapa {
  puntos: PuntoMapa[];
  origen?: Marca | null;
  destino?: Marca | null;
  taxi?: { lat: number; lng: number } | null;
  buscando?: boolean;
  encuadre?: Encuadre;
  // Paradas del taxi compartido: solo el lugar, nunca de quién es.
  paradas?: Array<{ lat: number; lng: number; esTuya: boolean }>;
  // Por dónde anduvo un taxi (migración 042). Una lista de TRAMOS, no de
  // puntos: entre dos tramos hay un hueco —salió de servicio, se quedó sin
  // cobertura— y unirlos con una recta dibujaría un viaje que no existió.
  //
  // `n` en cada punto es cuántas veces pasó por ahí; con `maxPasadas` se
  // convierte en color, de azul a rojo.
  recorrido?: Array<Array<{ lat: number; lng: number; n?: number }>>;
  maxPasadas?: number;
  // Hacia dónde va el coche, en grados desde el norte y en el sentido de las
  // agujas del reloj (lo que da `coords.heading` del GPS). Con valor, el plano
  // gira para poner eso arriba: lo que el conductor ve por el parabrisas es lo
  // que ve en la parte de arriba de la pantalla, y deja de tener que traducir
  // «a la derecha en el mapa» a «a mi izquierda» a sesenta por hora.
  //
  // null o sin valor: norte arriba, como siempre.
  rumbo?: number | null;
  // Hacia dónde apunta el COCHE, que no siempre es hacia dónde gira el plano.
  //
  // Parado, el plano se queda quieto —mirar un plano que gira en la mano marea
  // y no ayuda— pero el coche sí gira, porque es lo que dice hacia dónde está
  // encarado. En marcha las dos cosas coinciden. Sin valor, se deduce como
  // siempre del siguiente punto de la ruta.
  rumboCoche?: number | null;
  // Dónde está QUIEN MIRA el mapa. Solo lo usa el pasajero mientras va dentro
  // del taxi: hasta ahora, al subirse, se le quitaba el coche de la pantalla
  // —su posición no es asunto suyo— y con él se iba lo único que se movía. Le
  // quedaba un plano congelado durante todo el trayecto. Esto es lo que sí es
  // suyo: su propia posición, que además ya venía enviando.
  yo?: { lat: number; lng: number } | null;
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
  puntos, origen, destino, taxi, buscando, encuadre = 'persona', paradas, recorrido,
  maxPasadas = 1, rumbo = null, rumboCoche = null, yo = null,
}: PropiedadesMapa) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [caja, setCaja] = useState({ ancho: 0, alto: 0 });
  const [listo, setListo] = useState<PlanoListo | null>(planoCompartido);
  const [rutaTaxi, setRutaTaxi] = useState<Punto[] | null>(null);
  const [rutaViaje, setRutaViaje] = useState<Punto[] | null>(null);
  // Girar el plano ayuda conduciendo y estorba mirándolo parado, así que se
  // puede clavar el norte arriba tocando la rosa de los vientos.
  const [norteFijo, setNorteFijo] = useState(false);
  // Encuadre a mano (arrastrar y pellizcar). null = manda el automático.
  //
  // Mientras hay uno, el mapa deja de reencuadrarse solo: si siguiera
  // haciéndolo, cada latido del taxi devolvería la cámara a su sitio y sería
  // imposible mirar dos calles más allá. Se vuelve al automático con el botón,
  // que solo aparece cuando hay algo que deshacer.
  const [camaraManual, setCamaraManual] = useState<Camara | null>(null);
  const [rumboAplicado, setRumboAplicado] = useState<number | null>(null);

  // El rumbo del GPS baila unos grados en cada lectura aunque el coche vaya
  // recto. Aplicarlo tal cual sería un plano temblando sin parar, que además
  // de marear obliga a redibujar 3.700 calles cada vez. Por debajo de este
  // umbral se mantiene el giro que ya había.
  const UMBRAL_GIRO_GRADOS = 8;
  useEffect(() => {
    // Sin rumbo (parado, o el GPS no lo da) se CONSERVA el último: volver al
    // norte de golpe en cada semáforo es peor que quedarse como estaba.
    if (rumbo === null || !Number.isFinite(rumbo)) return;
    setRumboAplicado((previo) => {
      if (previo === null) return rumbo;
      // Diferencia por el lado corto: de 359° a 1° hay 2 grados, no 358.
      const diferencia = Math.abs(((rumbo - previo + 540) % 360) - 180);
      return diferencia < UMBRAL_GIRO_GRADOS ? previo : rumbo;
    });
  }, [rumbo]);

  const rumboMapa = norteFijo || rumboAplicado === null
    ? 0
    : (rumboAplicado * Math.PI) / 180;

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

  // El trayecto pedido. Arranca en donde va la persona cuando ya está dentro
  // del coche —lo que le queda por delante, que es lo que quiere ver— y en el
  // punto de recogida mientras todavía espera.
  //
  // Con el mismo freno que la ruta del taxi: se recalcula solo al moverse lo
  // bastante. Sin él, cada lectura del GPS rehace el camino entero sin que
  // cambie un píxel en pantalla.
  const desdeViaje = yo ?? origen ?? null;
  const ultimoCalculoViaje = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (!desdeViaje || !destino) {
      setRutaViaje(null);
      ultimoCalculoViaje.current = null;
      return;
    }
    const previo = ultimoCalculoViaje.current;
    const movido = previo === null
      || Math.abs(previo.lat - desdeViaje.lat) > 0.0002
      || Math.abs(previo.lng - desdeViaje.lng) > 0.0002;
    if (!movido) return;
    ultimoCalculoViaje.current = { lat: desdeViaje.lat, lng: desdeViaje.lng };

    let vivo = true;
    void calcularRuta(desdeViaje, destino).then((ruta) => {
      if (vivo) setRutaViaje(ruta ? ruta.puntos : null);
    });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desdeViaje?.lat, desdeViaje?.lng, destino?.lat, destino?.lng]);

  const { ancho, alto } = caja;

  // --- Cámara -------------------------------------------------------------
  const camaraAuto: Camara | null = useMemo(() => {
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
      if (yo) enfoque.push(aMundo(yo.lat, yo.lng));
      if (destino) enfoque.push(aMundo(destino.lat, destino.lng));
      for (const p of rutaViaje ?? []) enfoque.push(aMundo(p.lat, p.lng));
      for (const p of paradas ?? []) enfoque.push(aMundo(p.lat, p.lng));
    } else if (encuadre === 'recorrido') {
      // Entero: el sentido de esta vista es ver hasta dónde llegó, y un
      // encuadre que recorte la punta del recorrido no dice nada.
      for (const tramo of recorrido ?? []) {
        for (const p of tramo) enfoque.push(aMundo(p.lat, p.lng));
      }
    }

    const ajustado = encuadrar(enfoque, ancho, alto, listo.proy, {
      margen: Math.min(52, Math.max(24, Math.round(ancho * 0.11))),
      // Encuadrando a una sola persona no hace falta ver medio Malabo.
      metrosMinimos: encuadre === 'persona' ? 700 : 420,
      // El giro entra en el encuadre, no solo en el dibujo: una ruta que en
      // vertical cabe justa, en diagonal no, y sin esto se saldría media.
      rumbo: rumboMapa,
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
      rumbo: rumboMapa,
    };
  }, [listo, ancho, alto, origen, destino, taxi, yo, encuadre, rutaTaxi, rutaViaje, paradas,
    recorrido, rumboMapa]);

  const camara = camaraManual ?? camaraAuto;

  // --- Mover y acercar el plano con el dedo -------------------------------
  //
  // No hay librería de mapas, así que los gestos son estos veinte renglones:
  // arrastrar mueve el centro y pellizcar (o la rueda) cambia la escala. Es
  // todo lo que hace falta, porque la cámara ya era un par de números.
  //
  // Lo delicado es el giro: cuando el plano va orientado al rumbo del coche,
  // un dedo que se mueve hacia la derecha de la PANTALLA no se mueve hacia el
  // este del MUNDO. Hay que deshacer la rotación antes de aplicar el
  // desplazamiento, o el mapa se va en diagonal.
  const dedos = useRef(new Map<number, { x: number; y: number }>());
  const pellizcoPrevio = useRef<number | null>(null);

  const mundoDesdePantalla = (dx: number, dy: number, c: Camara) => {
    const r = c.rumbo ?? 0;
    const cos = Math.cos(r);
    const sen = Math.sin(r);
    return [
      (dx * cos - dy * sen) / c.escala,
      (dx * sen + dy * cos) / c.escala,
    ] as const;
  };

  const mover = (dxPantalla: number, dyPantalla: number) => {
    setCamaraManual((previa) => {
      const base = previa ?? camaraAuto;
      if (!base) return previa;
      const [dx, dy] = mundoDesdePantalla(dxPantalla, dyPantalla, base);
      return { ...base, cx: base.cx - dx, cy: base.cy - dy };
    });
  };

  const acercar = (factor: number) => {
    setCamaraManual((previa) => {
      const base = previa ?? camaraAuto;
      if (!base || !listo) return previa;
      // Topes: por debajo no se distingue una calle de otra y por encima se ve
      // el mar. Se calculan en metros de ancho de pantalla, que es lo que
      // significa algo, y no en «niveles de zoom».
      const porMetro = listo.proy.unidadesPorMetro;
      const maxEscala = ancho / (120 * porMetro);
      const minEscala = ancho / (40_000 * porMetro);
      const escala = Math.min(maxEscala, Math.max(minEscala, base.escala * factor));
      return { ...base, escala };
    });
  };

  const alBajarDedo = (e: React.PointerEvent) => {
    dedos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const alMoverDedo = (e: React.PointerEvent) => {
    const previo = dedos.current.get(e.pointerId);
    if (!previo) return;
    dedos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (dedos.current.size === 1) {
      mover(e.clientX - previo.x, e.clientY - previo.y);
      return;
    }
    // Dos dedos: la distancia entre ellos es la escala. El desplazamiento se
    // deja al gesto de un dedo — mezclar los dos hace que el mapa patine al
    // levantar uno.
    if (dedos.current.size === 2) {
      const [a, b] = [...dedos.current.values()];
      const separacion = Math.hypot(a.x - b.x, a.y - b.y);
      if (pellizcoPrevio.current !== null && pellizcoPrevio.current > 0) {
        acercar(separacion / pellizcoPrevio.current);
      }
      pellizcoPrevio.current = separacion;
    }
  };

  const alLevantarDedo = (e: React.PointerEvent) => {
    dedos.current.delete(e.pointerId);
    if (dedos.current.size < 2) pellizcoPrevio.current = null;
  };

  // --- Plano inclinado, como un navegador --------------------------------
  //
  // Solo conduciendo: cuando el plano ya va girado al rumbo del coche y nadie
  // ha clavado el norte. Ahí la inclinación gana de verdad —lo que queda
  // delante del capó ocupa más pantalla que lo que ya se ha dejado atrás, que
  // es justo lo que interesa mirar— y en las demás pantallas solo estorbaría:
  // el pasajero esperando y el operador mirando un recorrido quieren el plano
  // de frente, sin nada escorzado.
  //
  // Se hace con una transformación 3D de CSS sobre el propio `<svg>`, no
  // rehaciendo la proyección: el plano son 3.700 caminos ya construidos en
  // coordenadas planas, y volver a proyectarlos punto a punto en cada
  // fotograma es exactamente lo que este mapa evita para poder ir en un
  // Android de gama baja. La tarjeta gráfica hace el escorzo gratis.
  // Y se endereza en cuanto se toca el plano a mano: arrastrar sobre una
  // superficie escorzada no responde donde uno espera —el dedo recorre más
  // mundo arriba que abajo— así que mirar de cerca se hace en plano, y volver
  // al encuadre devuelve la inclinación.
  const inclinado = rumboAplicado !== null && !norteFijo && camaraManual === null;
  const GRADOS_INCLINACION = 52;
  // El origen abajo del todo: al inclinar sobre el borde inferior, el coche
  // —que va en el centro— baja al tercio de abajo y el resto de la pantalla se
  // llena de calle por venir. Es la composición de la foto.
  const estiloInclinacion = inclinado
    ? {
      transform: `perspective(${(alto * 1.15).toFixed(0)}px) rotateX(${GRADOS_INCLINACION}deg) scale(1.35)`,
      transformOrigin: '50% 100%',
    }
    : undefined;

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

    // Con el plano inclinado no van pines: saldrían escorzados y, sobre todo,
    // conduciendo no hacen falta —ningún navegador los enseña en marcha—. Lo
    // que importa ahí es la calle que viene y el coche.
    if (inclinado) return [];

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
  }, [listo, camara, puntos, ancho, alto, encuadre, inclinado]);

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
        {/* Funda ancha y opaca. Es lo que hace que la ruta se lea de un
            vistazo cruzando una avenida clara o una manzana vacía, y lo que
            distingue una trayectoria activa del resto del plano: se ve desde
            el otro lado de la pantalla, sin enfocar. */}
        <path
          d={d}
          fill="none"
          stroke="#08080a"
          strokeWidth={ancho2 + 8}
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
  //
  // El coche solo manda su posición cada 10-30 s (PanelConductor): entre dos
  // lecturas moviéndose de verdad hay cientos de metros, pero parado (o casi)
  // el único cambio entre lecturas es el ruido del GPS, unos pocos metros en
  // cualquier dirección — y ESO sí que hace temblar la flecha sin que el
  // coche se haya movido. Por debajo de un puñado de píxeles en pantalla se
  // descarta el nuevo rumbo y se mantiene el último válido.
  const UMBRAL_RUMBO_PX = 5;
  const ultimoRumbo = useRef(0);
  const rumboTaxi = (): number => {
    // Si viene el rumbo del GPS —el mapa del propio taxista— manda ese: es
    // hacia dónde apunta el coche de verdad, no hacia dónde va la carretera.
    // Antes se deducía siempre del siguiente punto de la ruta, y sin ruta
    // —parado, en servicio y esperando— no había nada que deducir: el coche se
    // quedaba mirando al este, que es lo que se ve en la pantalla del taxista
    // nada más entrar.
    //
    // Se le restan 90° porque el coche se dibuja apuntando al este (+X) y el
    // rumbo del GPS se mide desde el norte; y se le resta el giro del plano,
    // porque cuando el plano ya va orientado al rumbo, el coche tiene que
    // quedarse mirando hacia arriba y no girar dos veces.
    const suyo = rumboCoche ?? rumbo;
    if (suyo !== null && Number.isFinite(suyo)) {
      ultimoRumbo.current = suyo - 90 - (rumboMapa * 180) / Math.PI;
      return ultimoRumbo.current;
    }
    if (!taxi) return ultimoRumbo.current;
    const siguiente = rutaTaxi && rutaTaxi.length > 1 ? rutaTaxi[1] : origen;
    if (!siguiente) return ultimoRumbo.current;
    const a = pantalla(taxi.lat, taxi.lng);
    const b = pantalla(siguiente.lat, siguiente.lng);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < UMBRAL_RUMBO_PX) return ultimoRumbo.current;
    ultimoRumbo.current = (Math.atan2(dy, dx) * 180) / Math.PI;
    return ultimoRumbo.current;
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
          className="mapa-lienzo"
          style={estiloInclinacion}
          onPointerDown={alBajarDedo}
          onPointerMove={alMoverDedo}
          onPointerUp={alLevantarDedo}
          onPointerCancel={alLevantarDedo}
          onWheel={(e) => acercar(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
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

          {/* Por dónde anduvo el taxi. Cada tramo por separado, sin unir los
              huecos, y con un punto en el principio y el final de cada uno:
              en un recorrido de un mes, media ciudad pintada de naranja no
              dice nada si no se ve dónde arrancó cada trozo. */}
          {encuadre === 'recorrido' && (recorrido ?? []).map((tramo, i) => {
            const xy = tramo.map((p) => pantalla(p.lat, p.lng));
            const d = xy
              .map((q, j) => `${j === 0 ? 'M' : 'L'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`)
              .join('');
            return (
              <g key={`rastro-${i}`}>
                {/* La funda oscura va de una pieza, por debajo de todo: si se
                    dibujara por segmentos, cada trozo taparía el borde del
                    anterior y la línea saldría mordida. */}
                <path d={d} fill="none" stroke="#08080a" strokeWidth={7.5}
                  strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
                {/* Y el color, segmento a segmento: cada trozo lleva el de las
                    veces que pasó por ahí. */}
                {xy.slice(1).map((q, j) => (
                  <line
                    key={j}
                    x1={xy[j][0]} y1={xy[j][1]} x2={q[0]} y2={q[1]}
                    stroke={colorDeCalor(
                      Math.max(tramo[j].n ?? 1, tramo[j + 1].n ?? 1), maxPasadas,
                    )}
                    strokeWidth={3.4}
                    strokeLinecap="round"
                  />
                ))}
                <circle cx={xy[0][0]} cy={xy[0][1]} r={4} fill="#7ee081" stroke="#08080a" strokeWidth={1.5} />
                <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r={4}
                  fill="#ff6b6b" stroke="#08080a" strokeWidth={1.5} />
              </g>
            );
          })}

          {/* Rutas. En cada fase importa una sola: la del coche viniendo, o la
              del viaje. Dibujar las dos a la vez sería ruido. */}
          {/* Las trayectorias ACTIVAS —el coche viniendo, o el viaje en
              curso— van gruesas de verdad. Es lo que se mira conduciendo, de
              reojo y con sol: un trazo fino se pierde entre las calles. La
              del plano de fondo, cuando todavía no hay viaje, sigue siendo
              fina y clara: es una referencia, no una instrucción. */}
          {encuadre === 'recogida' && taxi && origen
            && trazoRuta('recogida', rutaTaxi, [taxi, origen], '#ffb020', 8)}
          {encuadre !== 'recogida' && origen && destino
            && trazoRuta(
              'viaje',
              rutaViaje,
              [desdeViaje ?? origen, destino],
              encuadre === 'viaje' ? '#ffb020' : '#f7f5f2',
              encuadre === 'viaje' ? 8 : 3.5,
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

          {/* Dónde va quien mira, mientras va dentro del taxi. Azul y redondo,
              deliberadamente distinto del coche ámbar: en ningún momento puede
              leerse como «ahí está el taxista», que es justo lo que se dejó de
              enseñar al subir. Va por encima de la ruta y por debajo del
              destino. */}
          {yo && (() => {
            const xy = pantalla(yo.lat, yo.lng);
            return (
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                <circle r={11} fill="#4a9eff" opacity={0.22} />
                <circle r={7} fill="#08080a" opacity={0.6} />
                <circle r={5.5} fill="#4a9eff" stroke="#f7f5f2" strokeWidth={2} />
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
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                {/* El coche del navegador de la foto: carrocería blanca,
                    parabrisas azul delante, luneta oscura y dos pilotos rojos
                    detrás. Esos colores son los que dicen hacia dónde mira sin
                    tener que seguir la punta de una flecha. Se dibuja apuntando
                    al este (+X) porque el rumbo en pantalla se mide igual.

                    Tres capas, y el orden importa:
                    1. Fuera, el estirón en Y que deshace el escorzo del plano
                       inclinado. Va en coordenadas de PANTALLA, porque lo que
                       aplasta es la pantalla.
                    2. Dentro, el giro del rumbo.
                    3. Y dentro del giro, el tamaño, UNIFORME.
                    Si el tamaño fuera no uniforme por fuera del giro, el coche
                    se deformaría distinto en cada rumbo: alargado yendo al
                    norte y aplastado yendo al este. */}
                <g transform={inclinado
                  ? `scale(1,${(1 / Math.cos((GRADOS_INCLINACION * Math.PI) / 180)).toFixed(3)})`
                  : undefined}
                >
                  <g transform={`rotate(${rumboTaxi().toFixed(1)})`}>
                    {/* Casi el doble de grande que antes. En un móvil de verdad
                        salía como una pastilla de treinta píxeles que no se
                        distinguía de un pin cualquiera; un navegador lo dibuja
                        del tamaño de un pulgar porque es lo único que se busca
                        con la vista sin apartarla de la carretera. */}
                    <g transform="scale(1.9)">
                      <ellipse rx={19} ry={12} fill="#08080a" opacity={0.34} />
                      {/* Sombra bajo el coche, corrida hacia atrás. */}
                      <rect x={-15} y={-7.6} width={30} height={15.2} rx={5.6}
                        fill="#08080a" opacity={0.45} transform="translate(-1.6,2.2)" />
                      {/* Carrocería: morro más estrecho que la cola, como un
                          coche visto de verdad desde arriba. */}
                      <path
                        d="M-14 -6.4 L6 -7.4 Q13 -6.6 15 0 Q13 6.6 6 7.4 L-14 6.4
                           Q-15.4 6.4 -15.4 4.6 L-15.4 -4.6 Q-15.4 -6.4 -14 -6.4 Z"
                        fill="#f4f4f2" stroke="#0d0d10" strokeWidth={1.5}
                        strokeLinejoin="round"
                      />
                      {/* Parabrisas: la mancha azul del morro. */}
                      <path d="M4.6 -5.2 L11 -3.4 Q12.6 0 11 3.4 L4.6 5.2 Z"
                        fill="#8fbdea" />
                      {/* Techo. */}
                      <rect x={-6.4} y={-5.4} width={10.4} height={10.8} rx={2.4}
                        fill="#e6e6e3" stroke="#0d0d10" strokeWidth={0.9} />
                      {/* Luneta trasera. */}
                      <path d="M-6.6 -4.6 L-10.4 -3.2 L-10.4 3.2 L-6.6 4.6 Z"
                        fill="#39485a" opacity={0.9} />
                      {/* Pilotos. */}
                      <rect x={-14.6} y={-5.8} width={2.6} height={3.2} rx={1} fill="#e5484d" />
                      <rect x={-14.6} y={2.6} width={2.6} height={3.2} rx={1} fill="#e5484d" />
                      {/* Retrovisores: dos puntos que rematan la silueta. */}
                      <rect x={2.4} y={-8.4} width={2.6} height={2} rx={0.8} fill="#d8d8d5" />
                      <rect x={2.4} y={6.4} width={2.6} height={2} rx={0.8} fill="#d8d8d5" />
                    </g>
                  </g>
                </g>
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
              <g transform={`translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`}>
                {/* La silueta del coche vista desde arriba, con el morro
                    hacia donde va. Se dibuja apuntando al este (+X) porque el
                    rumbo en pantalla se mide igual, así que el `rotate` es
                    directo y no hay que acordarse de sumar noventa grados.
                    Un disco oscuro debajo lo despega del plano: sin él, sobre
                    una avenida clara el coche se pierde. */}
                <circle r={14} fill="#08080a" opacity={0.5} />
                <g transform={`rotate(${rumboTaxi().toFixed(1)})`}>
                  {/* Carrocería: morro redondeado delante, cola más cuadrada
                      detrás. Es lo poco que hace falta para que se lea como un
                      coche y no como una flecha. */}
                  <path
                    d="M-9.5 -5.4 L4 -5.4 Q10.5 -5.4 11.5 0 Q10.5 5.4 4 5.4
                       L-9.5 5.4 Q-11.5 5.4 -11.5 3.4 L-11.5 -3.4
                       Q-11.5 -5.4 -9.5 -5.4 Z"
                    fill="#ffb020"
                    stroke="#08080a"
                    strokeWidth={1.8}
                    strokeLinejoin="round"
                  />
                  {/* Parabrisas y luneta: son las dos manchas que hacen que el
                      ojo sepa al instante cuál es el morro. */}
                  <path d="M2.5 -3.6 L6.8 -2.2 Q8.4 0 6.8 2.2 L2.5 3.6 Z"
                    fill="#1a1206" opacity={0.7} />
                  <rect x={-8.6} y={-3.6} width={3.2} height={7.2} rx={1}
                    fill="#1a1206" opacity={0.45} />
                </g>
              </g>
            );
          })()}
        </svg>
      ) : (
        <p className="mapa-cargando">Cargando el plano de Malabo…</p>
      )}
      {/* Solo cuando hay algo que deshacer: un botón permanente para «centrar»
          en un mapa que ya está centrado es ruido. */}
      {camaraManual !== null && (
        <button
          type="button"
          className="mapa-recentrar"
          onClick={() => setCamaraManual(null)}
        >
          Volver al encuadre
        </button>
      )}
      {/* Rosa de los vientos. Aparece solo cuando hay rumbo que seguir, que es
          conduciendo: un mapa que gira sin decir dónde está el norte
          desorienta más de lo que orienta. Y tocarla clava el norte arriba,
          porque girando se conduce pero mirando el plano parado se entiende
          peor. La aguja apunta siempre al norte de verdad. */}
      {rumboAplicado !== null && (
        <button
          type="button"
          className="mapa-brujula"
          onClick={() => setNorteFijo((fijo) => !fijo)}
          aria-label={norteFijo
            ? 'Norte fijo arriba. Tocar para girar el plano con el coche.'
            : 'El plano gira con el coche. Tocar para fijar el norte arriba.'}
          aria-pressed={norteFijo}
        >
          <svg viewBox="-18 -18 36 36" width={36} height={36} aria-hidden="true">
            <circle
              r={17}
              fill="rgba(8,8,10,0.72)"
              stroke={norteFijo ? '#ffb020' : 'rgba(247,245,242,0.25)'}
            />
            {/* La aguja y su «N» giran juntas: siempre señalan el norte de
                verdad, esté el plano como esté. */}
            <g transform={`rotate(${((-rumboMapa * 180) / Math.PI).toFixed(1)})`}>
              <path d="M0 -9 L3.5 3 L0 1 L-3.5 3 Z" fill="#ff6b6b" />
              <path d="M0 9 L3.5 -3 L0 -1 L-3.5 -3 Z" fill="rgba(247,245,242,0.5)" />
              <text x={0} y={-10.5} textAnchor="middle" fontSize={7} fill="#ff6b6b">N</text>
            </g>
          </svg>
        </button>
      )}
      <span className="mapa-atribucion">Calles © OpenStreetMap</span>
    </div>
  );
}

// Color de una parte del recorrido según cuántas veces pasó el taxi por ahí:
// de azul lo que hizo una sola vez a rojo lo que más repite.
//
// Se recorre el tono de HSL de 220° a 0°, que pasa por cian, verde y amarillo.
// Es la rampa de siempre de los mapas de calor y se lee sin leyenda; un
// degradado directo de azul a rojo pasaría por morados que no ordenan —nadie
// sabe si un violeta es más o menos que un magenta—.
//
// Y la escala arranca en la SEGUNDA pasada: `(n - 1) / (max - 1)`. Si arrancara
// en la primera, un recorrido sin ninguna repetición saldría entero rojo,
// diciendo «esta es su ruta de siempre» de un camino que hizo una vez.
export function colorDeCalor(pasadas: number, maxPasadas: number): string {
  if (maxPasadas <= 1) return 'hsl(220 90% 62%)';
  const t = Math.min(1, Math.max(0, (pasadas - 1) / (maxPasadas - 1)));
  return `hsl(${(220 * (1 - t)).toFixed(0)} 90% ${(62 - 6 * t).toFixed(0)}%)`;
}
