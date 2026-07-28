// Pantalla de la llamada. La misma para el pasajero y para el taxista: en una
// llamada los dos hacen lo mismo.
//
// Se pone por encima de todo lo demás a propósito. Cuando suena, lo único que
// importa es contestar o no; y cuando el taxista está conduciendo, tiene que
// poder colgar sin buscar el botón.
//
// No dice el nombre de quien llama porque no hace falta: solo puede ser la otra
// persona de este viaje. Decir «te llama tu taxista» es más claro que un nombre
// que el pasajero acaba de leer una vez.

import type { crearT } from './i18n';
import type { EstadoLlamada, MotivoFallo } from './llamada';

type T = ReturnType<typeof crearT>;

export interface PropiedadesPanelLlamada {
  estado: EstadoLlamada;
  motivoFallo: MotivoFallo;
  segundos: number;
  silenciado: boolean;
  otroLadoAusente: boolean;
  // Con quién se habla, para nombrarlo por su papel.
  otro: 'taxista' | 'pasajero';
  t: T;
  alAceptar: () => void;
  alColgar: () => void;
  alAlternarSilencio: () => void;
}

function reloj(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PanelLlamada({
  estado, motivoFallo, segundos, silenciado, otroLadoAusente, otro, t,
  alAceptar, alColgar, alAlternarSilencio,
}: PropiedadesPanelLlamada) {
  if (estado === 'inactiva') return null;

  const conQuien = otro === 'taxista' ? t('llamada.tuTaxista') : t('llamada.tuPasajero');

  return (
    <div className="capa-llamada" role="dialog" aria-modal="true" aria-label={conQuien}>
      <div className="llamada">
        <span className="llamada-con">{conQuien}</span>

        {estado === 'entrante' && <h1 className="llamada-titulo latiendo">{t('llamada.teLlama')}</h1>}
        {estado === 'saliente' && (
          <>
            <h1 className="llamada-titulo latiendo">{t('llamada.llamando')}</h1>
            {otroLadoAusente && <p className="llamada-nota">{t('llamada.sinAplicacion')}</p>}
          </>
        )}
        {estado === 'conectando' && <h1 className="llamada-titulo">{t('llamada.conectando')}</h1>}
        {estado === 'hablando' && (
          <>
            <h1 className="llamada-reloj">{reloj(segundos)}</h1>
            {/* Se dice el gasto porque aquí los datos cuestan dinero y una
                llamada larga se nota en la recarga. */}
            <p className="llamada-nota">{t('llamada.gasto')}</p>
          </>
        )}
        {estado === 'fallida' && (
          <>
            <h1 className="llamada-titulo">
              {motivoFallo === 'micro' ? t('llamada.sinMicro') : t('llamada.noSePudo')}
            </h1>
            <p className="llamada-nota">
              {motivoFallo === 'micro' ? t('llamada.sinMicroNota') : t('llamada.noSePudoNota')}
            </p>
          </>
        )}

        <div className="llamada-botones">
          {estado === 'entrante' && (
            <button type="button" className="principal grande" onClick={alAceptar}>
              {t('llamada.contestar')}
            </button>
          )}
          {estado === 'hablando' && (
            <button type="button" className="secundario" onClick={alAlternarSilencio}>
              {silenciado ? t('llamada.activarMicro') : t('llamada.silenciarMicro')}
            </button>
          )}
          <button type="button" className="colgar" onClick={alColgar}>
            {estado === 'entrante' ? t('llamada.rechazar')
              : estado === 'fallida' ? t('accion.volver')
                : t('llamada.colgar')}
          </button>
        </div>
      </div>
    </div>
  );
}
