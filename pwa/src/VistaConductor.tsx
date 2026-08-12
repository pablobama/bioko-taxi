// Vista del taxista: solo dibujo, ningún dato propio.
//
// Separada del panel a propósito. El panel se ocupa de pedir datos al
// servidor, latir y manejar errores; esta vista solo recibe lo que hay que
// pintar y qué hacer al pulsar. Así la galería de diseños puede mostrar todos
// los estados sin inventar una copia del maquetado.

import { useState } from 'react';
import type { DatosConductor, EstadoConductor, PasajeroConductor, ZonaConDemanda } from './api';
import type { crearT } from './i18n';

type T = ReturnType<typeof crearT>;

export interface AccionesConductor {
  alAbrirAjustes: () => void;
  alAbrirEstadisticas: () => void;
  // Solo para agentes de campo: abre las herramientas del mapa.
  alAbrirCampo?: () => void;
  alAbrirRecarga: () => void;
  alSuscribir: () => void;
  alAlternarServicio: () => void;
  alAceptar: (solicitudId: number) => void;
  alRechazar: (solicitudId: number) => void;
  alSalir: (solicitudId: number) => void;
  alLlegar: (solicitudId: number) => void;
  // El número es opcional: sin él el servidor acepta la confirmación
  // manual, que es el camino de todos los días.
  alRecoger: (solicitudId: number, pin?: string) => void;
  alDeclararAusente: (solicitudId: number) => void;
  alCompletar: (solicitudId: number) => void;
  alLlamar: (solicitudId: number) => void;
}

export interface PropiedadesVistaConductor {
  conductor: DatosConductor;
  estado: EstadoConductor | null;
  // Dónde se está pidiendo taxi, por barrio. null mientras no se ha pedido o
  // si no está en servicio: el dato se compra con la cuota semanal.
  demanda: { zonas: ZonaConDemanda[]; ventanaMin: number } | null;
  aviso?: string;
  ocupado?: boolean;
  t: T;
  acciones: AccionesConductor;
}

function BloquePasajero({
  pasajero, numero, ocupado, t, acciones,
}: {
  pasajero: PasajeroConductor;
  numero: number;
  ocupado: boolean;
  t: T;
  acciones: AccionesConductor;
}) {
  // Estado del teclado del número, por pasajero: con el coche lleno hay cuatro
  // bloques a la vez y cada uno lleva el suyo.
  const [comprobando, setComprobando] = useState(false);
  const [pin, setPin] = useState('');

  const llegado = pasajero.llegadoEn !== null;
  const id = pasajero.solicitudId;

  // Cuatro fases, no tres: «de camino» y «esperando en la puerta» son
  // situaciones distintas para quien conduce —una tiene prisa, la otra no— y
  // antes las dos decían lo mismo («de camino») aunque el reloj de espera ya
  // llevara minutos corriendo. El nombre de la fase decide también el color
  // de la franja del bloque entero: se lee de reojo, sin enfocar el texto.
  const fase = pasajero.estado === 'EN_CAMINO' && llegado ? 'esperando' : pasajero.estado;
  const etiquetaEstado: Record<string, string> = {
    ACEPTADO: t('pasajero.estado.aceptado'),
    EN_CAMINO: t('pasajero.estado.enCamino'),
    esperando: t('pasajero.estado.esperando'),
    RECOGIDO: t('pasajero.estado.recogido'),
  };
  const claseFase: Record<string, string> = {
    ACEPTADO: 'fase-aceptado',
    EN_CAMINO: 'fase-camino',
    esperando: 'fase-esperando',
    RECOGIDO: 'fase-bordo',
  };

  return (
    <div className={`pasajero ${claseFase[fase]} ${pasajero.estado === 'RECOGIDO' ? 'a-bordo' : ''}`}>
      <div className="pasajero-cabecera">
        <span className="numero-pasajero">{numero}</span>
        <div className="pasajero-ruta">
          {/* De dónde recogerlo (migración 046). El pin del mapa está en la
              posición real cuando la hay, y aquí se dice a cuántos metros del
              sitio conocido queda: sin esa cifra, el taxista ve un punto en
              medio de una manzana y no sabe si buscar en la puerta del
              supermercado o cien metros más allá. Nunca va el nombre de la
              persona: al taxista no le hace falta para llegar. */}
          <span className="ruta-desde">
            {pasajero.origen}
            {pasajero.recogidaEnGps && pasajero.metrosDeLaReferencia !== null
              && pasajero.metrosDeLaReferencia >= 25 && (
              <small> · {t('recogida.aMetros', { m: pasajero.metrosDeLaReferencia })}</small>
            )}
            {!pasajero.recogidaEnGps && <small> · {t('recogida.aproximada')}</small>}
          </span>
          <span className="ruta-hasta">{pasajero.destino}</span>
        </div>
      </div>
      <span className="pasajero-estado">{etiquetaEstado[fase] ?? fase}</span>

      {/* Llamada por internet, no `tel:`. Antes esto abría el marcador con el
          número del pasajero, que quedaba para siempre en el registro de
          llamadas del taxista y podía reutilizarse después del viaje. Ahora
          ninguno de los dos ve el número del otro. */}
      {pasajero.estado !== 'ACEPTADO' && (
        <button type="button" className="secundario llamar" disabled={ocupado}
          onClick={() => acciones.alLlamar(id)}>
          {t('accion.llamarPasajero')} <small>{t('llamada.privada')}</small>
        </button>
      )}

      {pasajero.estado === 'ACEPTADO' && (
        <button type="button" className="principal" disabled={ocupado}
          onClick={() => acciones.alSalir(id)}>
          {t('accion.voyDeCamino')}
        </button>
      )}

      {pasajero.estado === 'EN_CAMINO' && !llegado && (
        <button type="button" className="principal" disabled={ocupado}
          onClick={() => acciones.alLlegar(id)}>
          {t('accion.heLlegado')}
        </button>
      )}

      {pasajero.estado === 'EN_CAMINO' && llegado && (
        <p className="nota reloj">
          {t('espera.esperando', { min: Math.round(pasajero.relojEsperaSeg / 60) })}
          <small>{t('espera.mismoReloj')}</small>
        </p>
      )}

      {/* Recoger sigue siendo un solo toque: es lo que se hace cien veces al
          día y lo que el servidor acepta sin más («confirmación manual»).
          Comprobar el número es la salida para cuando hay dudas —varias
          personas esperando en la misma esquina— y por eso va debajo y en
          discreto, no compitiendo con la acción de siempre. */}
      {pasajero.estado === 'EN_CAMINO' && (
        <>
          <button type="button" className="principal" disabled={ocupado}
            onClick={() => acciones.alRecoger(id)}>
            {t('accion.pasajeroRecogido')}
          </button>

          {comprobando ? (
            <div className="comprobar-pin">
              <label htmlFor={`pin-${id}`}>{t('pin.pideleElNumero')}</label>
              <div className="fila">
                <input
                  id={`pin-${id}`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={pin}
                  placeholder="0000"
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                />
                <button
                  type="button"
                  className="principal"
                  disabled={ocupado || pin.length !== 4}
                  onClick={() => acciones.alRecoger(id, pin)}
                >
                  {t('pin.comprobar')}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="tenue" disabled={ocupado}
              onClick={() => setComprobando(true)}>
              {t('pin.comprobarNumero')}
            </button>
          )}
        </>
      )}

      {pasajero.estado === 'EN_CAMINO' && llegado && (
        <button type="button" className="tenue" disabled={ocupado}
          onClick={() => acciones.alDeclararAusente(id)}>
          {t('accion.noAparece')}
        </button>
      )}

      {pasajero.estado === 'RECOGIDO' && (
        <button type="button" className="principal" disabled={ocupado}
          onClick={() => acciones.alCompletar(id)}>
          {t('accion.viajeTerminado')}
        </button>
      )}
    </div>
  );
}

export default function VistaConductor({
  conductor, estado, demanda, aviso, ocupado = false, t, acciones,
}: PropiedadesVistaConductor) {
  const enServicio = estado !== null && estado.estado !== 'DESCONECTADO';
  const suscripcionVigente = estado?.suscripcionVigente ?? conductor.suscripcionVigente;
  const saldoXaf = estado?.saldoXaf ?? conductor.saldoXaf;
  const oferta = estado?.ofertas[0] ?? null;
  const pasajeros = estado?.pasajeros ?? [];
  const puedeTrabajar = conductor.verificado && suscripcionVigente;

  return (
    <section className="hoja">
      {aviso && <p className="aviso">{aviso}</p>}

      <div className="cabecera">
        <div className="identidad">
          <span className="nombre-propio">{conductor.nombre}</span>
          <span className="coche">
            {conductor.matricula}
            {conductor.marca ? ` · ${conductor.marca}` : ''}
            {conductor.carroceria === '4x4' ? ' · 4x4' : ''}
          </span>
        </div>
        <div className="acciones-cabecera">
          {/* Agente de campo (migración 025): mismo panel de taxi, más las
              herramientas del mapa. Solo aparece para quien lo es. */}
          {conductor.agente && acciones.alAbrirCampo && (
            <button type="button" className="ajustes" aria-label={t('campo.abrir')}
              onClick={acciones.alAbrirCampo}>🗺</button>
          )}
          <button type="button" className="ajustes" aria-label={t('cabecera.tusNumeros')}
            onClick={acciones.alAbrirEstadisticas}>▤</button>
          <button type="button" className="ajustes" aria-label={t('cabecera.tusDatos')}
            onClick={acciones.alAbrirAjustes}>⚙</button>
        </div>
      </div>

      {/* Bloqueos, en orden: sin verificar no hay nada que hacer; verificado
          pero sin cuota, solo pagar. */}
      {!conductor.verificado && (
        <div className="bloqueo">
          <span className="bloqueo-titulo">{t('bloqueo.pendiente.titulo')}</span>
          <p className="nota">{t('bloqueo.pendiente.nota')}</p>
        </div>
      )}

      {conductor.verificado && !suscripcionVigente && (
        <>
          <div className="bloqueo">
            <span className="bloqueo-titulo">{t('bloqueo.suscripcion.titulo')}</span>
            <p className="nota">{t('bloqueo.suscripcion.nota', { saldo: saldoXaf })}</p>
          </div>
          {saldoXaf >= 1500 ? (
            <button type="button" className="principal" disabled={ocupado}
              onClick={acciones.alSuscribir}>
              {t('accion.pagarSemana', { precio: 1500 })}
            </button>
          ) : (
            <button type="button" className="principal" disabled={ocupado}
              onClick={acciones.alAbrirRecarga}>
              {t('accion.recargarMonedero')}
            </button>
          )}
        </>
      )}

      {/* Oferta entrante: lo único que importa cuando llega. */}
      {oferta && (
        <div className="oferta">
          <span className="etiqueta-viva">{t('oferta.nuevaCarrera')}</span>
          <div className="pasajero-ruta grande">
            <span className="ruta-desde">{oferta.origen}</span>
            <span className="ruta-hasta">{oferta.destino}</span>
          </div>
          <p className="nota">
            {oferta.bandaPrecio
              ? t('oferta.precioOrientativo', { p25: oferta.bandaPrecio.p25, p75: oferta.bandaPrecio.p75 })
              : t('oferta.sinPrecio')}
          </p>
          <button type="button" className="principal grande" disabled={ocupado}
            onClick={() => acciones.alAceptar(oferta.solicitudId)}>
            {t('accion.aceptar')}
          </button>
          <button type="button" className="tenue" disabled={ocupado}
            onClick={() => acciones.alRechazar(oferta.solicitudId)}>
            {t('accion.rechazar')}
          </button>
        </div>
      )}

      {pasajeros.map((pasajero, indice) => (
        <BloquePasajero
          key={pasajero.solicitudId}
          pasajero={pasajero}
          numero={indice + 1}
          ocupado={ocupado}
          t={t}
          acciones={acciones}
        />
      ))}

      {/* Dónde hay trabajo. Solo cuando está en servicio y parado: con una
          oferta en pantalla o con pasajeros a bordo, esto no es lo que hay que
          mirar, y encima la petición cuesta datos. Por barrio y nunca por
          persona: un pin diría «alguien, solo, en esa dirección, ahora». */}
      {enServicio && demanda !== null && oferta === null && pasajeros.length === 0 && (
        <div className="demanda">
          <span className="demanda-titulo">{t('demanda.titulo')}</span>
          <span className="demanda-ventana">{t('demanda.ventana', { min: demanda.ventanaMin })}</span>
          {demanda.zonas.length === 0
            ? <p className="nota">{t('demanda.nadie')}</p>
            : (
              <ul className="ruta">
                {demanda.zonas.map((z) => (
                  <li key={z.zonaId}>
                    {t('demanda.zona', {
                      zona: z.zona,
                      pedidas: z.pedidas,
                      s: z.pedidas === 1 ? '' : 's',
                      sinTaxi: z.sinTaxi,
                      taxis: z.taxisAhora,
                      st: z.taxisAhora === 1 ? '' : 's',
                    })}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {/* Servicio: siempre al final, para que no compita con lo urgente. */}
      {puedeTrabajar && (
        <>
          {/* El barrio ya no se elige. Era una lista de los cuarenta y siete
              de Malabo, para buscar el tuyo conduciendo y al sol, y nada
              impedía quedarse en el que salía primero: el pasajero acababa
              recibiendo un taxi que no tenía cerca. Ahora al pulsar «entrar
              en servicio» se coge el GPS y el barrio es ese, el de donde
              estás. */}
          {!enServicio && (
            <p className="nota">{t('zona.teLocaliza')}</p>
          )}
          <button
            type="button"
            className={enServicio ? 'secundario' : 'principal grande'}
            disabled={ocupado}
            onClick={acciones.alAlternarServicio}
          >
            {enServicio ? t('accion.salirServicio') : t('accion.entrarServicio')}
          </button>
          {enServicio && estado && (
            <div className="tira-estado">
              <span className="punto-verde" />
              <span>{estado.zona}</span>
              <span className="separador">·</span>
              <span>{estado.plazas - estado.plazasLibres} / {estado.plazas}</span>
              <span className="separador">·</span>
              <button type="button" className="enlace" onClick={acciones.alAbrirRecarga}>
                {saldoXaf} XAF
              </button>
            </div>
          )}
          {!enServicio && (
            <button type="button" className="tenue" onClick={acciones.alAbrirRecarga}>
              {t('accion.recargarMonederoSaldo', { saldo: saldoXaf })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
