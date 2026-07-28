// Panel de estadísticas de uso. Los números salen del historial real: no hay
// nada estimado ni redondeado hacia arriba.

import { useEffect, useState } from 'react';
import { api } from './api';
import { type crearT, type Idioma, localeNumero } from './i18n';

type T = ReturnType<typeof crearT>;

function Dato({ valor, etiqueta }: { valor: number | string; etiqueta: string }) {
  return (
    <div className="dato">
      <span className="dato-valor">{valor}</span>
      <span className="dato-etiqueta">{etiqueta}</span>
    </div>
  );
}

function porcentaje(parte: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((parte / total) * 100)} %`;
}

export default function Estadisticas({
  t, idioma, alVolver,
}: { t: T; idioma: Idioma; alVolver: () => void }) {
  const [datos, setDatos] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState('');
  const locale = localeNumero(idioma);

  useEffect(() => {
    api.estadisticas()
      .then(setDatos)
      .catch((e) => setError(e instanceof Error ? e.message : t('stats.titulo')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <>
        <h1>{t('stats.titulo')}</h1>
        <p className="aviso">{error}</p>
        <button type="button" className="secundario" onClick={alVolver}>{t('accion.volver')}</button>
      </>
    );
  }
  if (!datos) {
    return <><h1>{t('stats.titulo')}</h1><p className="nota">{t('stats.cargando')}</p></>;
  }

  if (datos.rol === 'conductor') {
    const v = datos.viajes;
    const o = datos.ofertas;
    return (
      <>
        <h1>{t('stats.titulo')}</h1>
        <div className="rejilla">
          <Dato valor={v.completados} etiqueta={t('stats.drv.viajesHechos')} />
          <Dato valor={o.recibidas} etiqueta={t('stats.drv.carrerasOfrecidas')} />
          <Dato valor={porcentaje(o.aceptadas, o.recibidas)} etiqueta={t('stats.drv.aceptadas')} />
          <Dato
            valor={datos.reputacion.media === null ? '—' : datos.reputacion.media.toFixed(1)}
            etiqueta={t('stats.drv.nota', { n: datos.reputacion.valoraciones })}
          />
          <Dato valor={v.cancelados} etiqueta={t('stats.drv.canceladosPorTi')} />
          <Dato valor={v.ausencias} etiqueta={t('stats.drv.pasajerosAusentes')} />
        </div>

        <p className="nota">
          {t('stats.drv.monedero', {
            recargado: datos.monedero.recargado.toLocaleString(locale),
            pagado: datos.monedero.pagado_suscripcion.toLocaleString(locale),
          })}
        </p>

        {datos.zonasFrecuentes.length > 0 && (
          <>
            <p className="nota">{t('stats.drv.dondeRecogesMas')}</p>
            <ul className="ruta">
              {datos.zonasFrecuentes.map((z: { nombre: string; viajes: number }) => (
                <li key={z.nombre}>{z.nombre} · {z.viajes}</li>
              ))}
            </ul>
          </>
        )}
        <button type="button" className="secundario" onClick={alVolver}>{t('accion.volver')}</button>
      </>
    );
  }

  const v = datos.viajes;
  return (
    <>
      <h1>{t('stats.titulo')}</h1>
      <div className="rejilla">
        <Dato valor={v.completados} etiqueta={t('stats.pax.viajesHechos')} />
        <Dato valor={v.pedidos} etiqueta={t('stats.pax.vecesPediste')} />
        <Dato valor={v.sin_taxi} etiqueta={t('stats.pax.sinTaxiLibre')} />
        <Dato valor={v.cancelados} etiqueta={t('stats.pax.cancelaste')} />
      </div>

      {datos.strikes > 0 && (
        <p className={datos.bloqueado ? 'aviso' : 'nota'}>
          {datos.bloqueado
            ? t('stats.pax.bloqueado')
            : t('stats.pax.avisos', { n: datos.strikes, s: datos.strikes === 1 ? '' : 's' })}
        </p>
      )}

      {datos.destinosFrecuentes.length > 0 && (
        <>
          <p className="nota">{t('stats.pax.aDondeVasMas')}</p>
          <ul className="ruta">
            {datos.destinosFrecuentes.map((d: { nombre: string; veces: number }) => (
              <li key={d.nombre}>{d.nombre} · {d.veces}</li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="secundario" onClick={alVolver}>{t('accion.volver')}</button>
    </>
  );
}
