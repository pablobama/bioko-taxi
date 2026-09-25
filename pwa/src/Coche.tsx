// El coche que se dibuja en el plano.
//
// Vive aquí y no dentro de `Mapa` por dos razones: son ciento y pico líneas de
// dibujo que enterraban el mapa, y así la galería puede enseñarlo GRANDE. Un
// coche de treinta píxeles no se juzga a treinta píxeles: los errores se ven
// ampliado, y luego hay que volver a mirarlo a tamaño real para comprobar que
// lo que se lee ampliado se sigue leyendo pequeño.
//
// PUNTO DE VISTA (cambiado el 25/09, a petición del operador). Antes era un
// coche visto desde ATRÁS Y EN ALTO, copiado de un navegador: se veía la
// luneta y el maletero, y nada más. Ahora es CENITAL con un punto de
// perspectiva —casi desde arriba, un poco desde atrás—, que es lo que permite
// ver de una vez el capó, el parabrisas con el salpicadero debajo, el techo,
// la luneta, el maletero y un poco de los costados. Y con proporción
// deportiva: más largo que ancho, techo corto y retrasado, hombros marcados.
//
// El coche apunta ARRIBA (−Y). Quien lo use se encarga de girarlo.

// Silueta: morro afilado, hombros anchos a la altura de las ruedas y cola
// recogida. Escrita una vez y usada dos —chapa y sombra—, porque en cuanto
// hubiera dos copias se separarían al primer retoque.
const CARROCERIA = 'M0 -20.6 C2.4 -20.6 4.4 -20.1 5.9 -18.8 C7.8 -17.1 9.2 -14.2 9.7 -10.6 '
  + 'L10 -3 L10 7.4 C10 11.6 9.6 15.2 8.8 17.4 C8.2 19 7 19.7 5.1 19.7 '
  + 'L-5.1 19.7 C-7 19.7 -8.2 19 -8.8 17.4 C-9.6 15.2 -10 11.6 -10 7.4 '
  + 'L-10 -3 L-9.7 -10.6 C-9.2 -14.2 -7.8 -17.1 -5.9 -18.8 C-4.4 -20.1 -2.4 -20.6 0 -20.6 Z';

export interface PropiedadesCoche {
  // Tamaño final. 1 deja el coche en 20 × 40 unidades de SVG.
  escala?: number;
  // Los faros encendidos. Se pueden apagar para un coche parado en una ficha,
  // donde un haz de luz sobre fondo claro no dice nada.
  faros?: boolean;
  // Identificadores de los degradados. Dos coches en la misma página con los
  // mismos `id` comparten degradado, y el segundo se queda sin él: por eso se
  // pueden separar. En el plano solo hay uno, así que el valor por defecto
  // sirve para el caso normal.
  sufijo?: string;
}

export default function Coche({ escala = 1, faros = true, sufijo = '' }: PropiedadesCoche) {
  const id = (nombre: string) => `coche-${nombre}${sufijo}`;
  return (
    <g transform={`scale(${escala})`}>
      <defs>
        {/* La luz cruzada sobre la chapa: clara donde da el sol y apagada en
            los dos costados. Va A LO ANCHO y dentro del giro, así que gira con
            el coche y el bulto se lee igual en cualquier rumbo. */}
        <linearGradient id={id('chapa')} x1="-10" y1="0" x2="10" y2="0"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8f96a5" />
          <stop offset="0.14" stopColor="#d8dce4" />
          <stop offset="0.44" stopColor="#f1f4f8" />
          <stop offset="0.76" stopColor="#cdd2dc" />
          <stop offset="1" stopColor="#848b9b" />
        </linearGradient>
        {/* Los cristales, más claros arriba —donde se refleja el cielo— y más
            oscuros abajo. Es lo que dice que son cristales y no pegatinas. */}
        <linearGradient id={id('cristal')} x1="0" y1="-8" x2="0" y2="14"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fb4dc" />
          <stop offset="0.45" stopColor="#4f7cae" />
          <stop offset="1" stopColor="#2d5182" />
        </linearGradient>
        {/* El haz de los faros: se apaga hacia la punta en vez de cortarse,
            que es lo que hace que parezca luz y no un triángulo amarillo. */}
        <linearGradient id={id('haz')} x1="0" y1="-19" x2="0" y2="-46"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff4cd" stopOpacity="0.5" />
          <stop offset="0.35" stopColor="#ffe6a0" stopOpacity="0.2" />
          <stop offset="1" stopColor="#ffd75e" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={id('faro')}>
          <stop offset="0" stopColor="#fffbe8" stopOpacity="0.95" />
          <stop offset="0.5" stopColor="#ffe9a8" stopOpacity="0.4" />
          <stop offset="1" stopColor="#ffdd80" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Los faros, ENCENDIDOS y lo primero de todo: por debajo de la sombra y
          de la chapa, para que iluminen el plano sin comerse el coche. Además
          de dar bulto dicen hacia dónde MIRA: parado en un semáforo, la
          silueta sola no distingue el derecho del revés. */}
      {faros && (
        <g className="coche-faros">
          <path d={`M-6.6 -19 L-15 -44 L-0.6 -46 Z`} fill={`url(#${id('haz')})`} />
          <path d={`M6.6 -19 L15 -44 L0.6 -46 Z`} fill={`url(#${id('haz')})`} />
          <ellipse cy={-24} rx={9} ry={6.5} fill={`url(#${id('faro')})`} opacity={0.3} />
        </g>
      )}

      {/* Sombra: una suelta y ancha debajo, y otra pegada y corrida hacia
          atrás. Sin ellas el coche se pega al plano y pierde toda la altura
          que le da el resto del dibujo. */}
      <ellipse cy={2} rx={11.5} ry={20.5} fill="#08080a" opacity={0.1} />
      <path d={CARROCERIA} fill="#08080a" opacity={0.26}
        transform="translate(0,2.2) scale(1.03)" />

      {/* RUEDAS, por debajo de la chapa: solo se ve lo que sobresale, que es
          el neumático y no el disco. Por eso son negras, y por eso llevan un
          filo claro: es el brillo del hombro, lo único que las hace redondas a
          tamaño de plano. Las traseras, más anchas — es un coche deportivo y
          es donde primero se nota. */}
      <g className="coche-ruedas">
        <rect x={-11.6} y={-13.5} width={3.1} height={6.4} rx={1.5} fill="#0d1018" />
        <rect x={8.5} y={-13.5} width={3.1} height={6.4} rx={1.5} fill="#0d1018" />
        <rect x={-11.9} y={7.4} width={3.5} height={7.2} rx={1.6} fill="#0d1018" />
        <rect x={8.4} y={7.4} width={3.5} height={7.2} rx={1.6} fill="#0d1018" />
        {/* El brillo del hombro del neumático, POR DENTRO de la rueda. Fuera
            —como estaba— parecían cuatro arañazos sueltos en el plano. */}
        <path d="M-10.2 -12.6 L-10.2 -8.2 M10.2 -12.6 L10.2 -8.2
                 M-10.4 8.3 L-10.4 13.5 M10.4 8.3 L10.4 13.5"
          stroke="#585f70" strokeWidth={0.55} strokeLinecap="round" opacity={0.9} />
      </g>

      {/* RETROVISORES: brazo corto y carcasa, a la altura del parabrisas. Son
          la pieza más ancha del coche y por eso se ven desde arriba; el
          cristal mira hacia atrás y lleva su reflejo, o parecerían dos orejas
          de plástico. */}
      <g className="coche-espejos">
        <path d="M-9.5 -6.9 L-11.6 -7.6 Q-12.5 -7.9 -12.5 -6.7
                 Q-12.5 -5.5 -11.5 -5.7 L-9.5 -5.9 Z" fill="#cdd2de" />
        <path d="M9.5 -6.9 L11.6 -7.6 Q12.5 -7.9 12.5 -6.7
                 Q12.5 -5.5 11.5 -5.7 L9.5 -5.9 Z" fill="#cdd2de" />
        <path d="M-12.1 -7.1 Q-11.6 -7 -11.5 -6.2 L-10.6 -6.3 Q-10.8 -7.1 -11.4 -7.3 Z"
          fill="#4f7cae" />
        <path d="M12.1 -7.1 Q11.6 -7 11.5 -6.2 L10.6 -6.3 Q10.8 -7.1 11.4 -7.3 Z"
          fill="#4f7cae" />
      </g>

      {/* La chapa. */}
      <path d={CARROCERIA} fill={`url(#${id('chapa')})`} />

      {/* Los COSTADOS: dos sombras largas pegadas al borde. Son lo que dice
          que la carrocería tiene lados y no es una pegatina recortada — el
          «poco de los laterales» que se ve desde arriba cuando la cámara no
          está exactamente encima. */}
      <path d="M-9.8 -9.6 L-9.8 8.5 Q-9.6 14.2 -8.6 17.6" fill="none"
        stroke="#5f6675" strokeWidth={1.2} strokeLinecap="round" opacity={0.5} />
      <path d="M9.8 -9.6 L9.8 8.5 Q9.6 14.2 8.6 17.6" fill="none"
        stroke="#5f6675" strokeWidth={1.2} strokeLinecap="round" opacity={0.32} />

      {/* CAPÓ: dos nervios que salen del morro y mueren en el parabrisas. Es
          lo que le da cara de deportivo, y de paso dice dónde está el delante
          sin necesidad de leer los faros. */}
      <path d="M-4.6 -17.6 L-3.4 -8.6 M4.6 -17.6 L3.4 -8.6" fill="none"
        stroke="#b6bcc8" strokeWidth={0.55} strokeLinecap="round" opacity={0.85} />
      <path d="M0 -18.4 L0 -9.2" stroke="#ffffff" strokeWidth={0.5}
        strokeLinecap="round" opacity={0.35} />

      {/* FAROS: las ópticas, alargadas y pegadas a las esquinas del morro,
          como en un coche bajo. Encendidas llevan su núcleo blanco. */}
      <path d="M-8.4 -15.4 Q-6.2 -17.4 -3.6 -17.8 L-3.2 -15.8 Q-5.8 -15.2 -7.6 -13.6 Z"
        fill={faros ? '#fff6d2' : '#cfd5e0'} />
      <path d="M8.4 -15.4 Q6.2 -17.4 3.6 -17.8 L3.2 -15.8 Q5.8 -15.2 7.6 -13.6 Z"
        fill={faros ? '#fff6d2' : '#cfd5e0'} />

      {/* PARABRISAS y, debajo, el SALPICADERO. Aquí está el cambio de punto de
          vista: desde arriba el cristal delantero no es un espejo opaco, se ve
          a través. Lo que se ve es una banda oscura —el salpicadero—, el
          volante a la izquierda y el asiento del conductor. Es poquísimo
          dibujo y es lo que convierte la silueta en un coche de verdad. */}
      <path d="M-5.6 -9.4 L5.6 -9.4 Q6.4 -9.4 6.8 -8.4 L7.8 -2 L-7.8 -2 L-6.8 -8.4
               Q-6.4 -9.4 -5.6 -9.4 Z" fill={`url(#${id('cristal')})`} />
      {/* El salpicadero: una banda oscura pegada al capó, con el volante a la
          izquierda —se conduce por la derecha en Guinea— y los dos asientos
          insinuados detrás. Cuatro formas; con más, a tamaño de plano, esto se
          convierte en una mancha sucia. */}
      <path d="M-5.4 -8.9 L5.4 -8.9 L5.9 -6.6 L-5.9 -6.6 Z" fill="#111a2c" opacity={0.8} />
      <ellipse cx={-3.1} cy={-5} rx={1.5} ry={1.1} fill="none"
        stroke="#0f1626" strokeWidth={0.55} opacity={0.85} />
      <rect x={-5.2} y={-4.4} width={3.4} height={1.9} rx={0.8} fill="#0f1626" opacity={0.45} />
      <rect x={1.8} y={-4.4} width={3.4} height={1.9} rx={0.8} fill="#0f1626" opacity={0.45} />
      {/* El brillo del cristal: una franja diagonal. Sin ella el parabrisas se
          lee como un agujero. */}
      <path d="M-5.2 -9 L-1.4 -9 L-4.6 -2.4 L-7 -2.4 Z" fill="#ffffff" opacity={0.16} />

      {/* TECHO: corto y retrasado, que es lo que hace deportivo un perfil. Se
          insinúa con luz, no con un contorno: una caja clara dentro de otra
          caja clara se leía como un segundo coche pequeño encima del grande
          —pasó, y se vio ampliando el dibujo—. */}
      <path d="M-7.8 -2 L7.8 -2 L7.6 6.2 L-7.6 6.2 Z" fill="#eef1f6" opacity={0.85} />
      <path d="M-7.7 -1.5 L7.7 -1.5" stroke="#ffffff" strokeWidth={0.7}
        strokeLinecap="round" opacity={0.55} />
      {/* Las puertas: dos líneas cortas en cada costado, entre las ruedas. Es
          lo que termina de decir que el bulto blanco de los lados es chapa y
          no un borde del dibujo. */}
      <path d="M-9.6 -1.6 L-9.6 5.6 M9.6 -1.6 L9.6 5.6" stroke="#9aa1b0"
        strokeWidth={0.4} strokeLinecap="round" opacity={0.5} />

      {/* LUNETA: ancha y baja. Y el MALETERO detrás, con sus dos pliegues y su
          canto: sin ellos, de la luneta al paragolpes queda un vacío blanco
          que no dice nada. */}
      <path d="M-7.3 6.6 L7.3 6.6 L6.5 11 Q6.4 11.8 5.3 11.8 L-5.3 11.8
               Q-6.4 11.8 -6.5 11 Z" fill={`url(#${id('cristal')})`} />
      <path d="M-7.6 6.2 L7.6 6.2" stroke="#b9c0cc" strokeWidth={0.7}
        strokeLinecap="round" opacity={0.8} />
      <path d="M-6.4 12.4 L-8.2 17 M6.4 12.4 L8.2 17" stroke="#c3c8d2" strokeWidth={0.5}
        strokeLinecap="round" fill="none" />
      <path d="M-8.2 17.4 L8.2 17.4" stroke="#c3c8d2" strokeWidth={0.5}
        strokeLinecap="round" />

      {/* PILOTOS: dos barras rojas en las esquinas de atrás, lo más saturado
          del dibujo. Son lo que dice de un vistazo cuál es la parte de atrás
          cuando el coche viene de frente y no se le ven los faros. */}
      <rect x={-8} y={17.8} width={2.6} height={1.6} rx={0.7} fill="#d9202b" />
      <rect x={5.4} y={17.8} width={2.6} height={1.6} rx={0.7} fill="#d9202b" />
      {/* La sombra bajo el paragolpes, que cierra el coche por abajo y lo
          levanta del suelo. */}
      <path d="M-7 19.6 L7 19.6 Q6.6 20.4 5.4 20.4 L-5.4 20.4 Q-6.6 20.4 -7 19.6 Z"
        fill="#1b2133" opacity={0.85} />
    </g>
  );
}
