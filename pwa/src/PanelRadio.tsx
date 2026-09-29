// La radio del gremio: el botón de hablar y lo último que se ha dicho (075).
//
// EL BOTÓN FLOTA, Y ESO ES EL DISEÑO ENTERO. Antes era un rectángulo ancho
// dentro de una tarjeta, así que subía y bajaba según cuántos mensajes hubiera
// en la lista: su sitio dependía del contenido. Probándolo en un iPhone se vio
// lo que eso significa —hay que BUSCARLO con la vista antes de poder apretar—,
// que es justo lo que no se puede hacer conduciendo (P75-06).
//
// Ahora es redondo, grande y está clavado abajo a la derecha, donde cae el
// pulgar, pase lo que pase en el resto de la pantalla. Los mandos flotantes del
// taxista viven arriba a la izquierda, así que no se pisan.
//
// Lo demás se subordina a eso: encima del botón solo hay una línea con lo justo
// —quién habla, o quién fue el último— y la lista completa se abre pulsándola.
// Una lista siempre desplegada taparía el mapa, que es por donde conduce.

import { useState } from 'react';
import type { MensajeRadio } from './api';
import type { EstadoBoton } from './radio';

interface Props {
  estado: EstadoBoton;
  encendida: boolean;
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
  estado, encendida, habla, quedan, segundosMax, mensajes, aviso, oyentes,
  t, alApretar, alSoltar, alVolverAOir,
}: Props) {
  const [listaAbierta, setListaAbierta] = useState(false);
  if (!encendida) return null;

  const hablando = estado === 'hablando';
  const ocupado = estado === 'ocupado';
  const esperando = estado === 'pidiendo' || estado === 'enviando';
  const ultimo = mensajes[0];

  const rotulo = hablando
    ? t('radio.hablando', { seg: String(quedan) })
    : estado === 'enviando' ? t('radio.enviando')
      : estado === 'pidiendo' ? t('radio.pidiendo')
        : ocupado
          ? (habla ? t('radio.ocupado', { nombre: habla }) : t('radio.ocupadoSinNombre'))
          : t('radio.apretar');

  // Lo que se dice en la línea de encima del botón, por orden de urgencia: un
  // aviso manda sobre quién habla, y quién habla manda sobre el último mensaje.
  const linea = aviso
    ?? (ocupado ? rotulo : null)
    ?? (oyentes !== null && oyentes > 0 ? t('radio.oyentes', { n: String(oyentes) }) : null);

  return (
    <div className="radio-flotante" aria-label={t('radio.titulo')}>
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

      {linea !== null && (
        <p className={`radio-linea${aviso !== null ? ' radio-linea-aviso' : ''}`}>{linea}</p>
      )}

      {/* La pestaña: quién fue el último, y la puerta a la lista entera. */}
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

      <button
        type="button"
        className={`radio-boton${hablando ? ' radio-boton-hablando' : ''}`
          + `${ocupado ? ' radio-boton-ocupado' : ''}`}
        // Puntero y no clic: hay que saber cuándo se aprieta y cuándo se
        // suelta. `onPointerLeave` y `onPointerCancel` también sueltan, porque
        // un dedo que resbala fuera del botón nunca manda el «arriba», y sin
        // eso el turno se quedaría pillado hasta que caduque.
        onPointerDown={alApretar}
        onPointerUp={alSoltar}
        onPointerLeave={alSoltar}
        onPointerCancel={alSoltar}
        onContextMenu={(e) => e.preventDefault()}
        disabled={esperando || ocupado}
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
    </div>
  );
}
