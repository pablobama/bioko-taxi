// Panel de operador (PENDIENTES.md P21-01): verificar altas de conductor y
// ver los números gruesos del sistema. Solo en español a propósito — es
// herramienta interna, no cara al pasajero ni al taxista, así que no pasa
// por i18n.ts.

import { useEffect, useState } from 'react';
import { api, type ConductorOperador, type EstadisticasOperador } from './api';

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'Pendiente',
  verificado: 'Verificado',
  suspendido: 'Suspendido',
  bloqueado: 'Bloqueado',
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

const FILTROS = ['pendiente', 'verificado', 'suspendido', 'bloqueado', 'todos'] as const;

export default function PanelOperador({ alSalir }: { alSalir: () => void }) {
  const [stats, setStats] = useState<EstadisticasOperador | null>(null);
  const [conductores, setConductores] = useState<ConductorOperador[] | null>(null);
  const [filtro, setFiltro] = useState<(typeof FILTROS)[number]>('pendiente');
  const [ocupadoId, setOcupadoId] = useState<number | null>(null);
  const [error, setError] = useState('');

  function cargar() {
    api.estadisticasOperador().then(setStats).catch((e) => setError(e.message));
    api.conductoresOperador(filtro === 'todos' ? undefined : filtro)
      .then((r) => setConductores(r.conductores))
      .catch((e) => setError(e.message));
  }

  useEffect(cargar, [filtro]);

  async function cambiarEstado(id: number, estado: string) {
    setOcupadoId(id);
    setError('');
    try {
      await api.cambiarEstadoConductor(id, estado);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado.');
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
          {FILTROS.map((f) => (
            <button
              key={f} type="button"
              className={f === filtro ? 'idioma-activo' : undefined}
              onClick={() => setFiltro(f)}
            >
              {f === 'todos' ? 'Todos' : ETIQUETA_ESTADO[f]}
            </button>
          ))}
        </div>

        {conductores?.length === 0 && <p className="nota">No hay conductores en este estado.</p>}
        {conductores?.map((c) => (
          <FilaConductor
            key={c.id} conductor={c} ocupado={ocupadoId === c.id}
            alCambiarEstado={cambiarEstado}
          />
        ))}

        <button type="button" className="secundario" onClick={alSalir}>Salir</button>
      </section>
    </main>
  );
}
