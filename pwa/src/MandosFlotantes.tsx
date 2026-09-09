// Los mandos que flotan sobre el plano, en una columna a la izquierda.
//
// Antes vivían dentro de la hoja, en la cabecera, y la hoja se comía la mitad
// de abajo de la pantalla siempre. Conduciendo eso es media ciudad que no se
// ve; y para el pasajero, media pantalla de mapa gastada en un engranaje y una
// tabla que se usan una vez al mes.
//
// Ahora el plano ocupa la pantalla entera y la hoja flota encima, y el primer
// botón de esta columna la quita de en medio del todo. Con eso el mapa se ve
// completo de verdad, que es lo que se pedía.
//
// A la IZQUIERDA a propósito: arriba a la derecha ya están la rosa de los
// vientos y el conmutador de papeles. Dos columnas de botones en el mismo
// borde se pisarían, y esta se toca conduciendo.

interface Mando {
  icono: string;
  etiqueta: string;
  alPulsar: () => void;
}

export default function MandosFlotantes({
  plegada, alAlternar, etiquetaPlegar, etiquetaDesplegar, mandos,
}: {
  plegada: boolean;
  alAlternar: () => void;
  etiquetaPlegar: string;
  etiquetaDesplegar: string;
  mandos: Mando[];
}) {
  return (
    <div className="mandos-flotantes">
      <button
        type="button"
        className="ajustes mando-flotante"
        aria-label={plegada ? etiquetaDesplegar : etiquetaPlegar}
        aria-expanded={!plegada}
        onClick={alAlternar}
      >
        {plegada ? '▴' : '▾'}
      </button>
      {mandos.map((mando) => (
        <button
          key={mando.etiqueta}
          type="button"
          className="ajustes mando-flotante"
          aria-label={mando.etiqueta}
          onClick={mando.alPulsar}
        >
          {mando.icono}
        </button>
      ))}
    </div>
  );
}
