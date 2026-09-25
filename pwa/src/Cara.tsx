// La cara del pasajero en el plano.
//
// Donde antes había un punto ámbar ahora hay una cara sonriente. El punto
// decía «aquí hay algo» y la cara dice «aquí hay ALGUIEN», que es lo que el
// taxista necesita distinguir de un sitio, de una parada o de un destino
// cuando mira el plano en marcha y sin tiempo para leer.
//
// Se dibuja a la escala del plano, unos veinte píxeles: a ese tamaño un dibujo
// de cara solo funciona si tiene cuatro formas y mucho contraste. Dos ojos
// redondos, una boca de trazo grueso y un aro oscuro detrás para que no se
// pierda sobre una calle clara. Nada más — una nariz, unas cejas o una sonrisa
// fina se convierten en manchas.
//
// El color es el ámbar de siempre: el pasajero era ámbar antes de tener cara y
// sigue siéndolo, porque el taxi es blanco y el destino, blanco cuadrado. Un
// color nuevo obligaría a volver a aprender el plano entero.

export interface PropiedadesCara {
  // Radio de la cara. 10 es el tamaño del plano; la galería la enseña grande.
  radio?: number;
  // El color de la cara. Ámbar es el pasajero visto desde fuera —donde hay que
  // recogerlo—; azul es «tú», que es como se marca a quien mira el plano desde
  // dentro del taxi. La cara dice «persona» y el color dice cuál.
  color?: string;
}

export default function Cara({ radio = 10, color = '#ffb020' }: PropiedadesCara) {
  // Todo va en proporción al radio, así que la misma cara sirve a 10 y a 60
  // sin volver a medir nada a mano.
  const r = radio;
  return (
    <g className="cara-cliente">
      {/* El aro oscuro: separa la cara del plano tenga debajo lo que tenga. */}
      <circle r={r * 1.18} fill="#0a0a0b" />
      <circle r={r} fill={color} />
      {/* Ojos. Un poco altos y bastante separados: centrados y juntos la cara
          se lee como un botón con dos manchas. */}
      <circle cx={-r * 0.34} cy={-r * 0.2} r={r * 0.14} fill="#0a0a0b" />
      <circle cx={r * 0.34} cy={-r * 0.2} r={r * 0.14} fill="#0a0a0b" />
      {/* La boca: un arco abierto hacia arriba, con las puntas redondeadas. El
          grosor importa más que la curva — a veinte píxeles, un trazo fino
          desaparece y la cara se queda seria. */}
      <path
        d={`M${-r * 0.44} ${r * 0.18} Q0 ${r * 0.62} ${r * 0.44} ${r * 0.18}`}
        fill="none"
        stroke="#0a0a0b"
        strokeWidth={r * 0.17}
        strokeLinecap="round"
      />
    </g>
  );
}
