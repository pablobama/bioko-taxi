// «Mírame llegar» (migración 043), la mitad de quien mira.
//
// Se llega aquí abriendo un enlace: /?seguir=TOKEN. Quien lo abre casi nunca
// tiene la aplicación instalada —es la madre, la pareja, un amigo—, así que
// esta pantalla tiene que funcionar sola, sin sesión previa y sin más
// explicación que la que hay escrita en ella.
//
// Y tiene que verificar su número, por decisión del operador. Cuesta un SMS y
// es un estorbo real a las once de la noche; a cambio, el pasajero ve en su
// pantalla quién está mirando su viaje, con nombre y número, en vez de un
// enlace suelto que puede haber acabado en cualquier grupo.

import { useEffect, useRef, useState } from 'react';
import { api, type ViajeSeguido } from './api';
import type { T } from './i18n';
import Mapa from './Mapa';

const COOLDOWN_REENVIO_S = 60;

type Paso = 'cargando' | 'pide_numero' | 'pide_codigo' | 'viendo' | 'muerto';

export default function VistaSeguimiento({ token, t }: { token: string; t: T }) {
  const [paso, setPaso] = useState<Paso>('cargando');
  const [viaje, setViaje] = useState<ViajeSeguido | null>(null);
  const [telefono, setTelefono] = useState('');
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [segundosParaReenviar, setSegundosParaReenviar] = useState(0);

  // `mirar` se llama desde el reloj y desde los botones; guardarla en una
  // referencia evita rearmar el intervalo en cada render.
  const mirar = useRef<() => Promise<void>>(async () => undefined);
  mirar.current = async () => {
    try {
      const v = await api.verSeguimiento(token);
      setViaje(v);
      setPaso('viendo');
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      // «Verifica tu número» tiene arreglo aquí mismo; un enlace muerto no.
      if (/verifica tu número/i.test(mensaje)) setPaso((p) => (p === 'pide_codigo' ? p : 'pide_numero'));
      else setPaso('muerto');
    }
  };

  useEffect(() => { void mirar.current(); }, [token]);

  // Mientras el viaje va, se refresca solo. Diez segundos es el ritmo al que
  // el taxi manda su posición: pedir más a menudo gastaría datos de quien
  // mira —que aquí se pagan por megabyte— sin enseñar nada nuevo.
  useEffect(() => {
    if (paso !== 'viendo' || !viaje?.enMarcha) return;
    const reloj = setInterval(() => { void mirar.current(); }, 10_000);
    return () => clearInterval(reloj);
  }, [paso, viaje?.enMarcha]);

  useEffect(() => {
    if (segundosParaReenviar <= 0) return;
    const reloj = setTimeout(() => setSegundosParaReenviar((s) => s - 1), 1000);
    return () => clearTimeout(reloj);
  }, [segundosParaReenviar]);

  async function mandarCodigo() {
    setOcupado(true);
    setError('');
    try {
      // El número se guarda como perfil de pasajero: es la única forma que
      // tiene el servidor de saber a qué número mandar el SMS, y la misma que
      // usa cualquiera que se da de alta.
      await api.guardarPerfil({ telefono });
      await api.enviarCodigoVerificacion();
      setSegundosParaReenviar(COOLDOWN_REENVIO_S);
      setPaso('pide_codigo');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  }

  async function comprobarCodigo() {
    setOcupado(true);
    setError('');
    try {
      await api.comprobarCodigoVerificacion(codigo);
      await mirar.current();
    } catch {
      setError(t('verificacion.codigoIncorrecto'));
      setCodigo('');
    } finally {
      setOcupado(false);
    }
  }

  if (paso === 'cargando') {
    return <main className="lienzo"><section className="hoja"><p className="nota">…</p></section></main>;
  }

  if (paso === 'muerto') {
    return (
      <main className="lienzo">
        <section className="hoja">
          <h1>{t('seguido.titulo')}</h1>
          <p className="aviso">{t('seguido.caducado')}</p>
        </section>
      </main>
    );
  }

  if (paso === 'pide_numero' || paso === 'pide_codigo') {
    return (
      <main className="lienzo">
        <section className="hoja">
          <h1>{t('seguido.titulo')}</h1>
          <p className="nota">{t('seguido.pideNumero')}</p>
          {error && <p className="aviso">{error}</p>}
          {paso === 'pide_numero' ? (
            <>
              <input
                type="tel" inputMode="tel" autoComplete="tel"
                value={telefono} placeholder={t('seguido.numero')}
                onChange={(e) => setTelefono(e.target.value)}
              />
              <button
                type="button" className="principal"
                disabled={telefono.trim().length < 6 || ocupado}
                onClick={mandarCodigo}
              >
                {t('seguido.continuar')}
              </button>
            </>
          ) : (
            <>
              <input
                type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={codigo} placeholder={t('verificacion.placeholder')}
                onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button
                type="button" className="principal"
                disabled={codigo.length !== 6 || ocupado}
                onClick={comprobarCodigo}
              >
                {t('seguido.continuar')}
              </button>
              <button
                type="button" className="tenue"
                disabled={segundosParaReenviar > 0 || ocupado}
                onClick={mandarCodigo}
              >
                {segundosParaReenviar > 0
                  ? t('verificacion.reenviarEn', { seg: segundosParaReenviar })
                  : t('verificacion.reenviar')}
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  const p = viaje?.posicion ?? null;
  return (
    <main className="lienzo">
      <div className="capa-mapa">
        <Mapa
          puntos={[]}
          taxi={p ? { lat: p.lat, lng: p.lng } : null}
          origen={p ? { lat: p.lat, lng: p.lng, nombre: viaje?.origen ?? '' } : null}
          destino={viaje ? {
            lat: viaje.destinoLat, lng: viaje.destinoLng, nombre: viaje.destino,
          } : null}
          encuadre="viaje"
        />
      </div>
      <section className="hoja">
        <h1>{t('seguido.titulo')}</h1>
        {viaje && (
          <>
            <p>{t('seguido.destino', { destino: viaje.destino })}</p>
            {viaje.matricula && (
              <p className="nota">
                {t('seguido.enCoche', {
                  marca: viaje.marca ?? '', color: viaje.color ?? '', matricula: viaje.matricula,
                })}
              </p>
            )}
            {viaje.conductor && (
              <p className="nota">{t('seguido.conductor', { nombre: viaje.conductor })}</p>
            )}
            <p className="nota">
              {p === null
                ? t('seguido.sinPosicion')
                : t(p.de === 'pasajero' ? 'seguido.posicionPasajero' : 'seguido.posicionTaxi',
                  { seg: String(p.frescuraSeg) })}
            </p>
            {!viaje.enMarcha && <p className="nota"><strong>{t('seguido.termino')}</strong></p>}
          </>
        )}
      </section>
    </main>
  );
}
