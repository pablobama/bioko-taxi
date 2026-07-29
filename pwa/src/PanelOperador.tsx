// Panel de operador (PENDIENTES.md P21-01): verificar altas de conductor,
// confirmar pagos, y ver los números gruesos del sistema. Solo en español a
// propósito — es herramienta interna, no cara al pasajero ni al taxista, así
// que no pasa por i18n.ts.

import { useEffect, useState } from 'react';
import {
  api, type ConductorOperador, type EstadisticasOperador, type RecargaOperador,
} from './api';

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'Pendiente',
  verificado: 'Verificado',
  suspendido: 'Suspendido',
  bloqueado: 'Bloqueado',
};

const ETIQUETA_ESTADO_RECARGA: Record<string, string> = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  rechazada: 'Rechazada',
  caducada: 'Caducada',
};

const ETIQUETA_METODO: Record<string, string> = {
  muni_dinero: 'Muni Dinero',
  efectivo: 'Efectivo',
};

function Dato({ valor, etiqueta }: { valor: number | string; etiqueta: string }) {
  return (
    <div className="dato">
      <span className="dato-valor">{valor}</span>
      <span className="dato-etiqueta">{etiqueta}</span>
    </div>
  );
}

function FilaConductor({
  conductor, ocupado, alCambiarEstado,
}: {
  conductor: ConductorOperador;
  ocupado: boolean;
  alCambiarEstado: (id: number, estado: string) => void;
}) {
  const estado = conductor.estado_verificacion;
  return (
    <div className="oferta">
      <div className="oferta-ruta">{conductor.nombre}</div>
      <div className="nota">
        {conductor.telefono}
        {conductor.matricula && ` · ${conductor.matricula}`}
        {conductor.marca && ` · ${conductor.marca}`}
        {conductor.carroceria && ` · ${conductor.carroceria}`}
      </div>
      <div className="nota">Estado actual: <strong>{ETIQUETA_ESTADO[estado] ?? estado}</strong></div>
      <div className="fila">
        {estado !== 'verificado' && (
          <button
            type="button" className="principal" disabled={ocupado}
            onClick={() => alCambiarEstado(conductor.id, 'verificado')}
          >
            Verificar
          </button>
        )}
        {estado !== 'suspendido' && (
          <button
            type="button" className="secundario" disabled={ocupado}
            onClick={() => alCambiarEstado(conductor.id, 'suspendido')}
          >
            Suspender
          </button>
        )}
        {estado !== 'bloqueado' && (
          <button
            type="button" className="secundario" disabled={ocupado}
            onClick={() => alCambiarEstado(conductor.id, 'bloqueado')}
          >
            Bloquear
          </button>
        )}
      </div>
    </div>
  );
}

function FilaRecarga({
  recarga, ocupada, alConfirmar, alRechazar,
}: {
  recarga: RecargaOperador;
  ocupada: boolean;
  alConfirmar: (referencia: string) => void;
  alRechazar: (referencia: string) => void;
}) {
  return (
    <div className="oferta">
      <div className="oferta-ruta">
        {recarga.importe_xaf.toLocaleString('es')} XAF · {recarga.referencia}
      </div>
      <div className="nota">{recarga.conductor_nombre} · {recarga.conductor_telefono}</div>
      <div className="nota">
        Pago por <strong>{ETIQUETA_METODO[recarga.metodo] ?? recarga.metodo}</strong>
        {' · '}Estado: <strong>{ETIQUETA_ESTADO_RECARGA[recarga.estado] ?? recarga.estado}</strong>
      </div>
      {recarga.nota && <div className="nota">Nota: {recarga.nota}</div>}
      {recarga.estado === 'pendiente' && (
        <div className="fila">
          <button
            type="button" className="principal" disabled={ocupada}
            onClick={() => alConfirmar(recarga.referencia)}
          >
            Confirmar pago
          </button>
          <button
            type="button" className="secundario" disabled={ocupada}
            onClick={() => alRechazar(recarga.referencia)}
          >
            Rechazar
          </button>
        </div>
      )}
    </div>
  );
}

const SECCIONES = ['conductores', 'pagos'] as const;
const FILTROS_CONDUCTOR = ['pendiente', 'verificado', 'suspendido', 'bloqueado', 'todos'] as const;
const FILTROS_RECARGA = ['pendiente', 'confirmada', 'rechazada', 'caducada', 'todas'] as const;

export default function PanelOperador() {
  const [seccion, setSeccion] = useState<(typeof SECCIONES)[number]>('conductores');
  const [stats, setStats] = useState<EstadisticasOperador | null>(null);
  const [conductores, setConductores] = useState<ConductorOperador[] | null>(null);
  const [filtroConductor, setFiltroConductor] = useState<(typeof FILTROS_CONDUCTOR)[number]>('pendiente');
  const [recargas, setRecargas] = useState<RecargaOperador[] | null>(null);
  const [filtroRecarga, setFiltroRecarga] = useState<(typeof FILTROS_RECARGA)[number]>('pendiente');
  const [ocupadoId, setOcupadoId] = useState<number | string | null>(null);
  const [error, setError] = useState('');

  function cargarConductores() {
    api.conductoresOperador(filtroConductor === 'todos' ? undefined : filtroConductor)
      .then((r) => setConductores(r.conductores))
      .catch((e) => setError(e.message));
  }

  function cargarRecargas() {
    api.recargasOperador(filtroRecarga === 'todas' ? undefined : filtroRecarga)
      .then((r) => setRecargas(r.recargas))
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    api.estadisticasOperador().then(setStats).catch((e) => setError(e.message));
  }, []);

  useEffect(cargarConductores, [filtroConductor]);
  useEffect(cargarRecargas, [filtroRecarga]);

  async function cambiarEstadoConductor(id: number, estado: string) {
    setOcupadoId(id);
    setError('');
    try {
      await api.cambiarEstadoConductor(id, estado);
      cargarConductores();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado.');
    } finally {
      setOcupadoId(null);
    }
  }

  async function confirmarPago(referencia: string) {
    setOcupadoId(referencia);
    setError('');
    try {
      await api.confirmarRecarga(referencia);
      cargarRecargas();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo confirmar el pago.');
    } finally {
      setOcupadoId(null);
    }
  }

  async function rechazarPago(referencia: string) {
    const motivo = window.prompt('¿Por qué se rechaza esta recarga?');
    if (!motivo?.trim()) return;
    setOcupadoId(referencia);
    setError('');
    try {
      await api.rechazarRecarga(referencia, motivo.trim());
      cargarRecargas();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo rechazar el pago.');
    } finally {
      setOcupadoId(null);
    }
  }

  return (
    <main className="lienzo">
      <section className="hoja hoja-completa">
        <div className="cabecera">
          <h1>Panel de operador</h1>
        </div>
        {error && <p className="aviso">{error}</p>}

        {stats && (
          <div className="rejilla">
            <Dato valor={stats.conductores.pendientes} etiqueta="Conductores pendientes" />
            <Dato valor={stats.conductores.verificados} etiqueta="Conductores verificados" />
            <Dato valor={stats.enServicioAhora} etiqueta="En servicio ahora" />
            <Dato valor={stats.pasajeros} etiqueta="Pasajeros registrados" />
            <Dato valor={stats.solicitudes.ultimas_24h} etiqueta="Solicitudes (24 h)" />
            <Dato valor={stats.solicitudes.completadas} etiqueta="Viajes completados" />
            <Dato valor={stats.solicitudes.sin_taxi} etiqueta="Se quedaron sin taxi" />
            <Dato valor={`${stats.saldoTotalMonederosXaf.toLocaleString('es')} XAF`} etiqueta="Saldo total monederos" />
          </div>
        )}

        <div className="selector-idioma" style={{ marginTop: 16 }}>
          <button
            type="button" className={seccion === 'conductores' ? 'idioma-activo' : undefined}
            onClick={() => setSeccion('conductores')}
          >
            Conductores
          </button>
          <button
            type="button" className={seccion === 'pagos' ? 'idioma-activo' : undefined}
            onClick={() => setSeccion('pagos')}
          >
            Pagos
          </button>
        </div>

        {seccion === 'conductores' && (
          <>
            <div className="selector-idioma">
              {FILTROS_CONDUCTOR.map((f) => (
                <button
                  key={f} type="button"
                  className={f === filtroConductor ? 'idioma-activo' : undefined}
                  onClick={() => setFiltroConductor(f)}
                >
                  {f === 'todos' ? 'Todos' : ETIQUETA_ESTADO[f]}
                </button>
              ))}
            </div>
            {conductores?.length === 0 && <p className="nota">No hay conductores en este estado.</p>}
            {conductores?.map((c) => (
              <FilaConductor
                key={c.id} conductor={c} ocupado={ocupadoId === c.id}
                alCambiarEstado={cambiarEstadoConductor}
              />
            ))}
          </>
        )}

        {seccion === 'pagos' && (
          <>
            <div className="selector-idioma">
              {FILTROS_RECARGA.map((f) => (
                <button
                  key={f} type="button"
                  className={f === filtroRecarga ? 'idioma-activo' : undefined}
                  onClick={() => setFiltroRecarga(f)}
                >
                  {f === 'todas' ? 'Todas' : ETIQUETA_ESTADO_RECARGA[f]}
                </button>
              ))}
            </div>
            {recargas?.length === 0 && <p className="nota">No hay recargas en este estado.</p>}
            {recargas?.map((r) => (
              <FilaRecarga
                key={r.id} recarga={r} ocupada={ocupadoId === r.referencia}
                alConfirmar={confirmarPago} alRechazar={rechazarPago}
              />
            ))}
          </>
        )}

      </section>
    </main>
  );
}
