// Fondo de mapa estático: las calles de Malabo dibujadas una vez en SVG, sin
// interacción ni panorámica.
//
// Se usa en la galería de diseños, donde hay dos docenas de pantallas a la vez
// y montar un mapa de Leaflet en cada una sería insostenible. El mapa de
// verdad (Mapa.tsx) es el que va en la aplicación.

import { useEffect, useState } from 'react';

const ANCHO = 375;
const ALTO = 500;

type Plano = {
  recuadro: { sur: number; oeste: number; norte: number; este: number };
  vias: Array<{ c: number; p: number[] }>;
};

const GROSOR: Record<number, number> = { 1: 1.6, 2: 1.1, 3: 0.7, 4: 0.45 };
const COLOR: Record<number, string> = {
  1: '#6f6c5e', 2: '#5c5a4e', 3: '#464438', 4: '#3a382e',
};

// Un solo trazado por clase de vía: 3.756 elementos separados irían lentos.
function trazados(plano: Plano, centro: { lat: number; lng: number }, escala: number) {
  const cosLat = Math.cos((centro.lat * Math.PI) / 180);
  const aX = (lng: number) => (lng - centro.lng) * cosLat * escala + ANCHO / 2;
  const aY = (lat: number) => ALTO / 2 - (lat - centro.lat) * escala;

  const porClase: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const via of plano.vias) {
    const partes: string[] = [];
    for (let i = 0; i < via.p.length; i += 2) {
      const x = aX(via.p[i + 1]);
      const y = aY(via.p[i]);
      // Fuera del recuadro visible no hace falta dibujar.
      if (i === 0) partes.push(`M${x.toFixed(1)} ${y.toFixed(1)}`);
      else partes.push(`L${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    porClase[via.c]?.push(partes.join(''));
  }
  return porClase;
}

// La galería muestra dos docenas de fondos idénticos: proyectar las 3.756 vías
// una vez por marco sería un desperdicio. Se calcula una sola vez y se comparte.
let dibujoCompartido: Record<number, string[]> | null = null;
let calculo: Promise<Record<number, string[]>> | null = null;

function planoDibujado(): Promise<Record<number, string[]>> {
  if (dibujoCompartido) return Promise.resolve(dibujoCompartido);
  if (!calculo) {
    calculo = import('./mapa-malabo.json').then((modulo) => {
      const plano = (modulo.default ?? modulo) as unknown as Plano;
      // Escala grados→píxeles para que el centro de Malabo llene el marco.
      dibujoCompartido = trazados(plano, { lat: 3.7523, lng: 8.7741 }, 11_000);
      return dibujoCompartido;
    });
  }
  return calculo;
}

export default function FondoMapa() {
  const [dibujo, setDibujo] = useState<Record<number, string[]> | null>(dibujoCompartido);

  useEffect(() => {
    if (dibujo) return;
    let vivo = true;
    void planoDibujado().then((calculado) => {
      if (vivo) setDibujo(calculado);
    });
    return () => { vivo = false; };
  }, [dibujo]);

  return (
    <svg className="fondo-mapa" viewBox={`0 0 ${ANCHO} ${ALTO}`} aria-hidden>
      <rect width={ANCHO} height={ALTO} fill="#1b1b18" />
      {dibujo && [4, 3, 2, 1].map((clase) => (
        <path
          key={clase}
          d={dibujo[clase].join(' ')}
          stroke={COLOR[clase]}
          strokeWidth={GROSOR[clase]}
          fill="none"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
