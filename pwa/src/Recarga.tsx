// Recarga del monedero del taxista.
//
// La app no cobra nada: solo genera una referencia y explica cómo pagar. El
// saldo sube cuando el operador comprueba el ingreso. Eso se le dice al
// conductor con todas las letras, para que no se quede esperando que suba solo.

import { useEffect, useState } from 'react';
import { api } from './api';
import { type crearT, type Idioma, localeNumero } from './i18n';

type T = ReturnType<typeof crearT>;
type Datos = Awaited<ReturnType<typeof api.recargas>>;
type Pedida = Awaited<ReturnType<typeof api.pedirRecarga>>;

export default function Recarga({
  saldoXaf, t, idioma, alVolver, alConfirmarPosible,
}: {
  saldoXaf: number;
  t: T;
  idioma: Idioma;
  alVolver: () => void;
  // Para que el panel recargue el saldo al volver: puede que el operador haya
  // confirmado mientras tanto.
  alConfirmarPosible: () => void;
}) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [pedida, setPedida] = useState<Pedida | null>(null);
  const [importe, setImporte] = useState<number | null>(null);
  const [metodo, setMetodo] = useState<'muni_dinero' | 'efectivo'>('muni_dinero');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const locale = localeNumero(idioma);

  const ETIQUETA_ESTADO: Record<string, string> = {
    pendiente: t('recarga.estado.pendiente'),
    confirmada: t('recarga.estado.confirmada'),
    rechazada: t('recarga.estado.rechazada'),
    caducada: t('recarga.estado.caducada'),
  };

  useEffect(() => {
    api.recargas()
      .then((r) => {
        setDatos(r);
        setImporte(r.sugeridos[1] ?? r.minimoXaf);
        // Si ya hay una pendiente, se enseña esa en vez de pedir otra.
        const pendiente = r.recargas.find((x) => x.estado === 'pendiente');
        if (pendiente) {
          setPedida({
            referencia: pendiente.referencia,
            importeXaf: pendiente.importeXaf,
            metodo: pendiente.metodo,
            estado: pendiente.estado,
            instrucciones: {
              numero: pendiente.metodo === 'muni_dinero' ? r.muniDinero.numero : null,
              titular: pendiente.metodo === 'muni_dinero' ? r.muniDinero.titular : null,
              concepto: pendiente.referencia,
              texto: '',
            },
          });
        }
      })
      .catch((e) => setAviso(e instanceof Error ? e.message : t('recarga.titulo')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pedir() {
    if (importe === null) return;
    setOcupado(true);
    setAviso('');
    try {
      setPedida(await api.pedirRecarga(importe, metodo));
    } catch (error) {
      setAviso(error instanceof Error ? error.message : t('recarga.titulo'));
    } finally {
      setOcupado(false);
    }
  }

  function volver() {
    alConfirmarPosible();
    alVolver();
  }

  if (!datos) {
    return (
      <>
        <h1>{t('recarga.titulo')}</h1>
        <p className="nota">{t('recarga.cargando')}</p>
      </>
    );
  }

  // Ya hay una recarga en marcha: lo único que toca es pagar y esperar.
  if (pedida) {
    const esMuni = pedida.metodo === 'muni_dinero';
    return (
      <>
        <h1>{t('recarga.paga', { importe: pedida.importeXaf })}</h1>
        {aviso && <p className="aviso">{aviso}</p>}

        {esMuni ? (
          <div className="pago">
            <span className="pago-etiqueta">{t('recarga.muniDinero')}</span>
            <span className="pago-numero">{pedida.instrucciones.numero}</span>
            <span className="pago-titular">{pedida.instrucciones.titular}</span>
          </div>
        ) : (
          <div className="pago">
            <span className="pago-etiqueta">{t('recarga.efectivo')}</span>
            <span className="pago-titular">{t('recarga.enEfectivoNota')}</span>
          </div>
        )}

        <div className="pago referencia">
          <span className="pago-etiqueta">{t('recarga.ponReferencia')}</span>
          <span className="pago-numero">{pedida.referencia}</span>
        </div>

        <div className="bloqueo">
          <span className="bloqueo-titulo">{t('recarga.saldoNoHaSubido')}</span>
          <p className="nota">{t('recarga.subeCuandoConfirmemos')}</p>
        </div>

        <button type="button" className="principal" onClick={volver}>
          {t('accion.yaHePagado')}
        </button>
        <button type="button" className="tenue" onClick={volver}>{t('accion.volver')}</button>
      </>
    );
  }

  return (
    <>
      <h1>{t('recarga.titulo')}</h1>
      {aviso && <p className="aviso">{aviso}</p>}
      <p className="nota">
        {t('recarga.tienes', { saldo: saldoXaf, cuota: datos.minimoXaf })}
      </p>

      <span className="pago-etiqueta">{t('recarga.cuantoQuieres')}</span>
      <div className="importes">
        {datos.sugeridos.map((valor) => (
          <button
            key={valor}
            type="button"
            className={importe === valor ? 'importe elegido-importe' : 'importe'}
            onClick={() => setImporte(valor)}
          >
            <span className="importe-cifra">{valor.toLocaleString(locale)}</span>
            <span className="importe-semanas">
              {Math.round(valor / datos.minimoXaf)} {valor / datos.minimoXaf === 1 ? t('recarga.semana') : t('recarga.semanas')}
            </span>
          </button>
        ))}
      </div>

      <span className="pago-etiqueta">{t('recarga.comoVasAPagar')}</span>
      <div className="fila">
        <button
          type="button"
          className={metodo === 'muni_dinero' ? 'principal' : 'secundario'}
          onClick={() => setMetodo('muni_dinero')}
        >
          {t('recarga.muniDinero')}
        </button>
        <button
          type="button"
          className={metodo === 'efectivo' ? 'principal' : 'secundario'}
          onClick={() => setMetodo('efectivo')}
        >
          {t('recarga.efectivo')}
        </button>
      </div>

      {metodo === 'muni_dinero' && (
        <p className="nota">
          {t('recarga.enviarasA', { numero: datos.muniDinero.numero, titular: datos.muniDinero.titular })}
        </p>
      )}

      <button type="button" className="principal grande" disabled={ocupado || importe === null}
        onClick={pedir}>
        {ocupado ? t('accion.unMomento') : t('accion.continuar')}
      </button>

      {datos.recargas.length > 0 && (
        <>
          <span className="pago-etiqueta">{t('recarga.ultimasRecargas')}</span>
          <ul className="ruta">
            {datos.recargas.slice(0, 5).map((r) => (
              <li key={r.id} className={r.estado === 'confirmada' ? 'tuya' : undefined}>
                {r.importeXaf.toLocaleString(locale)} XAF ·{' '}
                {ETIQUETA_ESTADO[r.estado] ?? r.estado}
                {r.nota ? ` · ${r.nota}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      <button type="button" className="tenue" onClick={volver}>{t('accion.volver')}</button>
    </>
  );
}
