// Vista del pasajero: solo dibujo, ningún dato propio. Igual que la del
// taxista, separada del panel para que la galería de diseños pueda mostrar
// todos los estados sin duplicar el maquetado.

import type { DestinoSugerido, DetalleSolicitud, ReferenciaSugerida, TaxisCerca } from './api';
import IconoCategoria from './IconoCategoria';
import type { crearT } from './i18n';

type T = ReturnType<typeof crearT>;

export type FaseCliente =
  | 'destino' | 'esperando' | 'sin_taxi' | 'asignado' | 'gracias';

export interface AccionesCliente {
  alAbrirAjustes: () => void;
  alAbrirEstadisticas: () => void;
  alPedir: () => void;
  alCancelar: () => void;
  alLimpiar: () => void;
  alValorar: (puntuacion: number) => void;
  alQuitarOrigen: () => void;
  alLlamar: () => void;
  alElegirDestino: (destino: DestinoSugerido) => void;
  alEscribirDestino: () => void;
}

export interface PropiedadesVistaCliente {
  fase: FaseCliente;
  detalle: DetalleSolicitud | null;
  origen: ReferenciaSugerida | null;
  destino: ReferenciaSugerida | null;
  // Si el GPS ya respondió (aunque sea negándose) y si dio coordenadas.
  gpsResuelto: boolean;
  hayCoordenadas: boolean;
  // Cuántos taxis podrían venir a por él. null mientras no se sabe (sin
  // origen, o sin conexión): entonces no se dice nada, que es más honesto que
  // enseñar un cero o un número viejo.
  taxisCerca: TaxisCerca | null;
  valorada: boolean;
  aviso?: string;
  t: T;
  // Destinos de un toque, ya ordenados por el servidor.
  sugeridos: DestinoSugerido[];
  // Si la persona ha pedido escribir en vez de elegir de la lista.
  escribiendo: boolean;
  // Recién pedido: cabe arrepentirse sin coste ninguno.
  puedeDeshacer: boolean;
  // Segundos que quedan de cancelación gratuita, o null si no aplica.
  segundosGracia: number | null;
  // Los buscadores de origen y destino se pasan hechos: llevan su propio
  // estado de escritura y sus llamadas al gazetteer.
  buscadorDestino: React.ReactNode;
  buscadorOrigen: React.ReactNode;
}

function Estrellas({ media, valoraciones, t }: { media: number | null; valoraciones: number; t: T }) {
  if (media === null) {
    return <span className="reputacion nueva">{t('reputacion.nueva')}</span>;
  }
  const llenas = Math.round(media);
  return (
    <span className="reputacion">
      <span className="estrellas">{'★'.repeat(llenas)}{'☆'.repeat(5 - llenas)}</span>
      {media.toFixed(1)} <small>({valoraciones})</small>
    </span>
  );
}

export default function VistaCliente({
  fase, detalle, origen, destino, gpsResuelto, hayCoordenadas, taxisCerca,
  valorada, aviso, t, sugeridos, escribiendo, puedeDeshacer, segundosGracia,
  buscadorDestino, buscadorOrigen, acciones,
}: PropiedadesVistaCliente & { acciones: AccionesCliente }) {
  return (
    <section className="hoja">
      {aviso && <p className="aviso">{aviso}</p>}

      {fase === 'destino' && (
        <>
          <div className="cabecera">
            <h1>{t('destino.titulo')}</h1>
            <div className="acciones-cabecera">
              <button type="button" className="ajustes" aria-label={t('cabecera.tusNumeros')}
                onClick={acciones.alAbrirEstadisticas}>▤</button>
              <button type="button" className="ajustes" aria-label={t('cabecera.tusDatos')}
                onClick={acciones.alAbrirAjustes}>⚙</button>
            </div>
          </div>

          {/* Escribir es la barrera más alta de la aplicación. Con destino ya
              elegido, o cuando la persona ha pedido escribir, manda el
              buscador; si no, se ofrecen sus sitios de siempre en botones
              grandes y el viaje se pide con dos toques y cero letras. */}
          {destino || escribiendo || sugeridos.length === 0 ? (
            buscadorDestino
          ) : (
            <>
              <ul className="sugeridos">
                {sugeridos.map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => acciones.alElegirDestino(d)}>
                      <span className="sug-sigla">
                        <IconoCategoria categoria={d.categoria} t={t} tamano={26} />
                      </span>
                      <span className="sug-textos">
                        <span className="sugerido-nombre">{d.nombre}</span>
                        <span className="sug-zona">
                          {d.motivo === 'tuyo' ? t('destino.vasAMenudo') : d.zona}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="tenue" onClick={acciones.alEscribirDestino}>
                {t('destino.escribirOtro')}
              </button>
            </>
          )}

          {origen ? (
            <p className="ubicacion-ok">
              <span className="punto-verde" />
              {t('origen.salesDe')} <strong>{origen.nombre}</strong>
              <button type="button" className="enlace" onClick={acciones.alQuitarOrigen}>
                {t('origen.cambiar')}
              </button>
            </p>
          ) : (
            <>
              <p className="nota">
                {gpsResuelto && !hayCoordenadas
                  ? t('origen.sinGpsResuelto')
                  : t('origen.buscando')}
              </p>
              {buscadorOrigen}
            </>
          )}

          {/* Cuántos taxis pueden venir, justo encima del botón: es lo que
              decide si merece la pena pulsarlo. Hoy esa pregunta cuesta 90
              segundos de espera para oír «no hay». Un CONTEO, nunca posiciones:
              un punto que se puede seguir es una herramienta de acoso, y encima
              invita a ir a pararlo en la calle, donde la plataforma no cobra. */}
          {origen && taxisCerca !== null && (
            taxisCerca.disponibles === 0
              ? (
                <p className="cobertura cobertura-vacia">
                  <span className="punto-rojo" />
                  <strong>{t('cobertura.ninguno')}</strong>
                  <small>{t('cobertura.ningunoNota')}</small>
                </p>
              )
              : (
                <p className="cobertura">
                  <span className="punto-verde" />
                  <strong>
                    {t('cobertura.hay', {
                      n: taxisCerca.disponibles,
                      s: taxisCerca.disponibles === 1 ? '' : 's',
                    })}
                  </strong>
                  {taxisCerca.enTuZona > 0 && (
                    <small>
                      {t('cobertura.enTuZona', {
                        n: taxisCerca.enTuZona,
                        zona: taxisCerca.zona,
                      })}
                    </small>
                  )}
                </p>
              )
          )}

          <button
            type="button"
            className="principal grande"
            disabled={!origen || !destino}
            onClick={acciones.alPedir}
          >
            {t('accion.pedirTaxi')}
          </button>
        </>
      )}

      {fase === 'esperando' && (
        <>
          <h1 className="latiendo">{t('esperando.titulo')}</h1>
          <p className="nota">
            {detalle ? t('esperando.hacia', { destino: detalle.destino }) : ''}
          </p>
          <p className="nota">{t('esperando.nota')}</p>
          {/* Un toque sin querer en «Pedir taxi» crea una solicitud de verdad.
              Durante unos segundos el botón de salir se ofrece grande y con el
              nombre de lo que la persona quiere hacer —deshacer— en vez de
              escondido. Pasado ese rato vuelve a su sitio para no competir con
              la espera. Aquí cancelar no cuesta nada en ningún caso: el aviso
              solo existe si ya hay taxi asignado. */}
          {puedeDeshacer ? (
            <button type="button" className="secundario" onClick={acciones.alCancelar}>
              {t('accion.deshacer')}
            </button>
          ) : (
            <button type="button" className="tenue" onClick={acciones.alCancelar}>
              {t('accion.cancelar')}
            </button>
          )}
        </>
      )}

      {fase === 'sin_taxi' && (
        <>
          <h1>{t('sinTaxi.titulo')}</h1>
          <p className="nota">{t('sinTaxi.nota')}</p>
          <button type="button" className="principal grande" onClick={acciones.alLimpiar}>
            {t('accion.volverAPedir')}
          </button>
        </>
      )}

      {fase === 'asignado' && detalle && (
        <>
          {detalle.taxiHaLlegado && detalle.estado !== 'RECOGIDO' && (
            <p className="llegado">
              <span className="punto-pulso" />
              {t('asignado.llegando')}
            </p>
          )}

          {detalle.taxi ? (
            <h1 className="eta">
              <strong>{detalle.taxi.etaMin}</strong> {t('asignado.min')}
              <small>
                {detalle.estado === 'RECOGIDO' ? t('asignado.paraLlegar') : t('asignado.paraRecogerte')}
              </small>
            </h1>
          ) : (
            <h1>{t('asignado.titulo')}</h1>
          )}

          {/* El número que confirma que este taxi viene a por TI.
              En una parada del Mercado Central hay varias personas esperando y
              el taxista no sabe el nombre de ninguna —el diseño no lo comparte
              a propósito—. Preguntar «¿qué número tienes?» resuelve eso en un
              segundo. Se enseña mientras el taxi viene y desaparece al subir,
              que es cuando deja de servir para nada.
              Va en monoespaciada y grande porque es para dictarlo en voz alta,
              a veces por la ventanilla y con ruido de calle. */}
          {detalle.pin && detalle.estado !== 'RECOGIDO' && (
            <div className="pin">
              <span className="pin-etiqueta">{t('pin.etiqueta')}</span>
              <span className="pin-numero">{detalle.pin}</span>
            </div>
          )}

          <div className="ficha">
            <span className="matricula">{detalle.matricula ?? '—'}</span>
            <div className="ficha-datos">
              <span className="nombre-propio">{detalle.conductor}</span>
              <span className="coche">
                {[detalle.marca, detalle.color].filter(Boolean).join(' · ')}
              </span>
              {detalle.reputacion && (
                <Estrellas
                  media={detalle.reputacion.media}
                  valoraciones={detalle.reputacion.valoraciones}
                  t={t}
                />
              )}
            </div>
          </div>

          {detalle.compartido && detalle.compartido.ruta.length > 1 && (
            <div className="compartido">
              <span className="etiqueta-viva">
                {t('compartido.etiqueta', { n: detalle.compartido.pasajerosABordo })}
              </span>
              <ul className="ruta">
                {detalle.compartido.ruta.map((parada, i) => (
                  <li key={i} className={parada.esTuya ? 'tuya' : undefined}>
                    {parada.destino}{parada.esTuya && ` · ${t('compartido.tuParada')}`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Hablar con el taxista es lo que resuelve el encuentro cuando no
              se encuentran: en Malabo las direcciones postales no sirven. Va
              por internet y ninguno de los dos ve el número del otro. */}
          <button type="button" className="secundario llamar" onClick={acciones.alLlamar}>
            {t('llamada.llamar')} <small>{t('llamada.privada')}</small>
          </button>

          <p className="nota">
            {detalle.estado === 'RECOGIDO'
              ? t('asignado.notaRecogido')
              : t('asignado.notaEsperando')}
            {detalle.taxi && t('asignado.tiempoAproximado')}
          </p>

          {/* Con reloj de verdad. Antes ponía «gratis el primer minuto» sin
              decir por qué segundo iba, así que no se sabía si cancelar salía
              gratis o costaba un aviso; y a los tres avisos se bloquea el
              servicio. Con la cuenta a la vista, la decisión es informada. */}
          {detalle.estado === 'ACEPTADO' && (
            <button type="button" className="tenue" onClick={acciones.alCancelar}>
              {segundosGracia !== null && segundosGracia > 0
                ? t('accion.cancelarGratisSeg', { seg: segundosGracia })
                : t('accion.cancelarConAviso')}
            </button>
          )}
          {detalle.estado === 'RECOGIDO' && (
            <button type="button" className="tenue" onClick={acciones.alLimpiar}>
              {t('accion.yaMeBaje')}
            </button>
          )}
        </>
      )}

      {fase === 'gracias' && (
        <>
          <h1>{t('gracias.titulo')}</h1>
          {detalle?.reputacion && !valorada ? (
            <>
              <p className="nota">{t('gracias.comoFue', { conductor: detalle.conductor ?? '' })}</p>
              <div className="valorar">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => acciones.alValorar(n)}
                    aria-label={`${n} ★`}>★</button>
                ))}
              </div>
            </>
          ) : (
            valorada && <p className="nota">{t('gracias.gracias')}</p>
          )}
          <button type="button" className="principal" onClick={acciones.alLimpiar}>
            {t('accion.pedirOtroTaxi')}
          </button>
        </>
      )}
    </section>
  );
}
