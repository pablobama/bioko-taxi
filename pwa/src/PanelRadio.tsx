// La radio del gremio: el botón de hablar y lo último que se ha dicho (075).
//
// Un botón grande y redondo, que es lo único que se puede pulsar a ciegas. El
// estado se dice por color, por texto y por pitido, los tres a la vez: quien usa
// esto está conduciendo, y cualquiera de los tres canales puede fallarle —el
// sonido si lo tiene silenciado, la vista si está mirando la carretera—.

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
  if (!encendida) return null;

  const hablando = estado === 'hablando';
  const ocupado = estado === 'ocupado';
  const esperando = estado === 'pidiendo' || estado === 'enviando';

  const rotulo = hablando
    ? t('radio.hablando', { seg: String(quedan) })
    : estado === 'enviando' ? t('radio.enviando')
      : estado === 'pidiendo' ? t('radio.pidiendo')
        : ocupado
          ? (habla ? t('radio.ocupado', { nombre: habla }) : t('radio.ocupadoSinNombre'))
          : t('radio.apretar');

  return (
    <section className="radio" aria-label={t('radio.titulo')}>
      <div className="radio-cabecera">
        <h3>{t('radio.titulo')}</h3>
        {/* Que no suena con la pantalla apagada se dice aquí y no se esconde: un
            taxista que lo descubra conduciendo ya no vuelve a confiar en esto. */}
        <span className="radio-nota">{t('radio.noSuena')}</span>
      </div>

      <button
        type="button"
        className={`radio-boton${hablando ? ' radio-boton-hablando' : ''}`
          + `${ocupado ? ' radio-boton-ocupado' : ''}`}
        // Puntero y no clic: hay que saber cuándo se aprieta y cuándo se suelta.
        // `onPointerLeave` y `onPointerCancel` también sueltan, porque un dedo
        // que resbala fuera del botón nunca manda el «arriba».
        onPointerDown={alApretar}
        onPointerUp={alSoltar}
        onPointerLeave={alSoltar}
        onPointerCancel={alSoltar}
        // Sin esto, mantener apretado en un móvil arrastra la página y el
        // navegador se queda el gesto.
        onContextMenu={(e) => e.preventDefault()}
        disabled={esperando || ocupado}
        aria-pressed={hablando}
      >
        <span className="radio-icono" aria-hidden="true">{hablando ? '🎙️' : '📢'}</span>
        <span className="radio-rotulo">{rotulo}</span>
        {hablando && (
          <span
            className="radio-barra"
            style={{ width: `${Math.round((quedan / Math.max(1, segundosMax)) * 100)}%` }}
          />
        )}
      </button>

      {aviso !== null && <p className="radio-aviso">{aviso}</p>}
      {aviso === null && oyentes !== null && oyentes > 0 && (
        <p className="radio-oyentes">{t('radio.oyentes', { n: String(oyentes) })}</p>
      )}

      {mensajes.length === 0 ? (
        <p className="radio-vacia">{t('radio.sinMensajes')}</p>
      ) : (
        <ul className="radio-lista">
          {mensajes.map((m) => (
            <li key={m.id} className={m.mio ? 'radio-mio' : undefined}>
              <button type="button" onClick={() => alVolverAOir(m.id)} title={t('radio.volverAOir')}>
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
    </section>
  );
}
