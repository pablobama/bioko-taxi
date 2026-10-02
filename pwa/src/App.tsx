// Raíz de la aplicación: decide QUÉ interfaz se muestra según lo que sea este
// dispositivo (migración 016).
//
//   sin registrar → elección de rol → registro de pasajero o de taxista
//   pasajero      → PanelCliente
//   taxista       → PanelConductor
//
// Las dos interfaces conviven aquí a propósito, para poder ver el sistema
// completo en localhost. Cuando se separen serán dos aplicaciones distintas:
// el pasajero seguirá siendo esta PWA y el taxista la app Android de
// android/, que ya existe.
//
// Un dispositivo es de un rol o del otro, nunca de los dos: el historial y los
// strikes cuelgan del dispositivo, así que cambiar de rol es cosa del operador.

import { useEffect, useState } from 'react';
import {
  api, asegurarSecreto, enPruebasLocales, uuidDispositivo,
  type DatosConductor, type Perfil, type PuntoMapa,
} from './api';
import { mensajeDeError, useConexion } from './conexion';
import Estadisticas from './Estadisticas';
import { crearT, fijarIdioma, idiomaActual, type Idioma } from './i18n';

type T = ReturnType<typeof crearT>;
import Mapa from './Mapa';
import PanelCliente from './PanelCliente';
import PanelConductor from './PanelConductor';
import PanelOperador from './PanelOperador';
import VistaSeguimiento from './VistaSeguimiento';
import { alternarSilencio, estaSilenciado, prepararSonido } from './sonidos';

const IDIOMAS: Array<{ id: Idioma; etiqueta: string }> = [
  { id: 'es', etiqueta: 'ES' },
  { id: 'fr', etiqueta: 'FR' },
  { id: 'en', etiqueta: 'EN' },
];

// Selector de idioma: se usa en la elección de rol (lo primero que se ve) y
// en ajustes de cada rol, para poder cambiarlo más tarde.
function SelectorIdioma({ idioma, alCambiar }: { idioma: Idioma; alCambiar: (i: Idioma) => void }) {
  return (
    <div className="selector-idioma">
      {IDIOMAS.map((i) => (
        <button
          key={i.id}
          type="button"
          className={i.id === idioma ? 'idioma-activo' : undefined}
          onClick={() => alCambiar(i.id)}
        >
          {i.etiqueta}
        </button>
      ))}
    </div>
  );
}

type Pantalla =
  | 'cargando' | 'elegir_rol' | 'volver' | 'alta_cliente' | 'alta_conductor'
  | 'cliente' | 'conductor' | 'ajustes_conductor' | 'estadisticas_conductor'
  | 'operador' | 'campo' | 'verificar_telefono';

// El teléfono del operador puede cambiar de papel sin tocar la consola:
// pasajero ↔ taxista ↔ operador. Cada papel guarda su PROPIO uuid de
// dispositivo (la identidad del servidor no se toca: tres papeles son tres
// dispositivos) y el conmutador solo los intercambia en localStorage.
//
// Únicamente aparece en un teléfono que haya entrado como operador alguna
// vez: para cualquier otro usuario no existe.
function ConmutadorRol({ actual }: { actual: 'cliente' | 'conductor' | 'operador' | null }) {
  const uuidOperador = localStorage.getItem('uuidOperador');
  if (!uuidOperador) return null;

  async function cambiarA(rol: 'cliente' | 'conductor' | 'operador') {
    let uuid: string;
    if (rol === 'operador') {
      uuid = uuidOperador!;
    } else {
      const almacen = rol === 'cliente' ? 'uuidRolCliente' : 'uuidRolConductor';
      let guardado = localStorage.getItem(almacen);
      if (!guardado) {
        guardado = crypto.randomUUID();
        localStorage.setItem(almacen, guardado);
      }
      uuid = guardado;
      // El papel de taxista estrenaba un dispositivo sin conductor detrás, así
      // que caía en la pantalla de alta —que pide un teléfono ya dado de alta
      // como conductor, cosa que el operador no tiene— y se quedaba fuera. El
      // servidor le prepara aquí su taxi (migración 048).
      //
      // Se llama ANTES de cambiar el uuid guardado: la petición tiene que
      // viajar con la identidad de operador, que es la única autorizada.
      if (rol === 'conductor') {
        try {
          await api.prepararMiTaxi(uuid);
        } catch {
          // Sin red o sin permiso: se sigue igual y acabará en el alta, que es
          // exactamente lo que pasaba antes. Nada empeora.
        }
      }
    }
    // La sesión cacheada y el viaje activo pertenecen al papel anterior.
    localStorage.removeItem('ultimaSesion');
    localStorage.removeItem('solicitudActiva');
    localStorage.setItem('dispositivo', uuid);
    // Sin la query: en pruebas locales ?dispositivo= volvería a imponer la
    // identidad que se acaba de dejar.
    window.location.replace(window.location.pathname);
  }

  return (
    <div className="conmutador-rol">
      {([['cliente', 'Pasajero'], ['conductor', 'Taxista'], ['operador', 'Operador']] as const).map(([rol, etiqueta]) => (
        <button
          key={rol}
          type="button"
          className={rol === actual ? 'rol-activo' : undefined}
          onClick={() => { if (rol !== actual) void cambiarA(rol); }}
        >
          {etiqueta}
        </button>
      ))}
    </div>
  );
}

// Última sesión conocida, para poder abrir la aplicación sin cobertura.
//
// Se guarda solo QUÉ ES este dispositivo (pasajero o taxista) y su ficha, que
// es información estable. El estado de los viajes no se guarda nunca: eso
// cambia solo y enseñarlo viejo sería mentir.
const CLAVE_SESION = 'ultimaSesion';

type Sesion = Awaited<ReturnType<typeof api.sesion>>;

function guardarSesionLocal(sesion: Sesion): void {
  try {
    localStorage.setItem(CLAVE_SESION, JSON.stringify(sesion));
  } catch {
    // Almacenamiento lleno o bloqueado: se sigue sin recordar nada.
  }
}

function sesionGuardada(): Sesion | null {
  try {
    const crudo = localStorage.getItem(CLAVE_SESION);
    return crudo ? (JSON.parse(crudo) as Sesion) : null;
  } catch {
    return null;
  }
}

// Enlace de activación del operador: ?operador=<uuid>. Existe porque en un
// navegador móvil no hay consola donde pegar el uuid a mano.
//
// A diferencia de ?dispositivo= (solo pruebas locales, sería regalar la
// suplantación), esto sí funciona en producción — pero con una salvaguarda:
// no se toca NADA hasta que el servidor confirma que ese uuid es de
// operador. Un enlace con un uuid inventado no puede costarle su identidad a
// un pasajero que lo abra por error o por malicia: se ignora y ya.
//
// El uuid se borra de la barra de direcciones al activarse, para que no se
// quede en el historial de navegación a la vista de cualquiera.
async function activarOperadorPorUrl(): Promise<boolean> {
  const candidato = new URLSearchParams(window.location.search).get('operador');
  if (!candidato || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidato)) {
    return false;
  }
  try {
    const respuesta = await fetch('/api/sesion', {
      headers: { 'x-dispositivo': candidato.toLowerCase() },
    });
    const sesion = (await respuesta.json()) as { rol?: string };
    if (sesion.rol !== 'operador') return false;
  } catch {
    return false;
  }
  localStorage.setItem('dispositivo', candidato.toLowerCase());
  localStorage.removeItem(CLAVE_SESION);
  localStorage.removeItem('solicitudActiva');
  window.history.replaceState(null, '', window.location.pathname);
  return true;
}

export default function App() {
  const [pantalla, setPantalla] = useState<Pantalla>('cargando');
  // Qué papel se eligió en la pantalla anterior, y el número que ya se
  // comprobó (migración 078). El número viaja hasta el formulario de alta para
  // no pedirlo dos veces; en null significa «sin teléfono, solo correo», que es
  // un camino que el pasajero sigue teniendo.
  const [rolDeAlta, setRolDeAlta] = useState<'cliente' | 'conductor'>('cliente');
  const [telefonoDeAlta, setTelefonoDeAlta] = useState<string | null>(null);
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [conductor, setConductor] = useState<DatosConductor | null>(null);
  const [puntos, setPuntos] = useState<PuntoMapa[]>([]);
  const [aviso, setAviso] = useState('');
  const [idioma, setIdioma] = useState<Idioma>(idiomaActual());
  const enLinea = useConexion();
  const t = crearT(idioma);

  function cambiarIdioma(nuevo: Idioma) {
    fijarIdioma(nuevo);
    setIdioma(nuevo);
  }

  async function cargarSesion() {
    try {
      const sesion = await api.sesion();
      // El secreto de este dispositivo (migración 069, P15-04). Se pide
      // DESPUÉS de la sesión porque hasta entonces el dispositivo puede no
      // existir en el servidor, y una sola vez en toda su vida: a partir de
      // aquí, conocer el uuid ya no basta para ser tú. Las peticiones que
      // salgan mientras tanto lo esperan solas (ver `asegurarSecreto`).
      void asegurarSecreto();
      // Se guarda para poder abrir sin cobertura. Quién eres y qué eres no
      // cambia de un minuto a otro, al revés que el estado de un viaje: esto
      // sí se puede recordar sin mentirle a nadie.
      guardarSesionLocal(sesion);
      if (sesion.rol === 'operador') {
        // No se guarda como «última sesión»: es un dispositivo de trabajo,
        // no tiene sentido recordarlo sin cobertura como a un pasajero.
        // Sí se recuerda QUÉ uuid es el del operador, para que el conmutador
        // de papeles pueda volver a él desde los otros dos.
        localStorage.setItem('uuidOperador', uuidDispositivo());
        setPantalla('operador');
      } else if (sesion.rol === 'conductor' && sesion.conductor) {
        setConductor(sesion.conductor);
        // Migración 027: sin el teléfono confirmado por SMS no se entra al
        // panel, aunque la cuenta ya exista de antes.
        setPantalla(sesion.conductor.telefonoVerificado ? 'conductor' : 'verificar_telefono');
      } else if (sesion.rol === 'cliente' && sesion.cliente) {
        setPerfil(sesion.cliente);
        setPantalla(sesion.cliente.telefonoVerificado ? 'cliente' : 'verificar_telefono');
      } else {
        setPantalla('elegir_rol');
      }
    } catch (error) {
      // Sin red se tira de la última sesión conocida. Mandar a la pantalla de
      // «¿quién eres?» a alguien que lleva meses usando la aplicación parece
      // que se le ha borrado la cuenta, cuando lo único que pasa es que ahora
      // mismo no hay cobertura.
      const guardada = sesionGuardada();
      if (guardada?.rol === 'conductor' && guardada.conductor) {
        setConductor(guardada.conductor);
        setPantalla('conductor');
      } else if (guardada?.rol === 'cliente' && guardada.cliente) {
        setPerfil(guardada.cliente);
        setPantalla('cliente');
      } else {
        setPantalla('elegir_rol');
      }
      // Si fue la red, ya lo dice la banda de arriba; repetirlo aquí sería
      // decir dos veces lo mismo.
      setAviso(mensajeDeError(error, t('app.sinServidor')));
    }
  }

  useEffect(() => {
    api.mapa().then((m) => setPuntos(m.referencias)).catch(() => undefined);
    // El enlace de activación tiene que resolverse ANTES de preguntar quién
    // soy: si no, la primera sesión se pediría con la identidad vieja.
    void activarOperadorPorUrl().then(() => cargarSesion());
  }, []);

  // Volver a leer QUIÉN ERES al volver a la aplicación.
  //
  // La sesión se leía una sola vez, al abrir. El papel de una persona casi
  // nunca cambia, pero cuando cambia es porque alguien acaba de cambiarlo y
  // está esperando a que aparezca: el operador nombra agente de campo a un
  // pasajero y en su teléfono no pasa nada, porque la aplicación sigue con el
  // perfil que leyó al arrancar. Había que cerrarla y volver a abrirla, y eso
  // no lo adivina nadie.
  //
  // Solo se actualiza el perfil, NO la pantalla: quien esté a mitad de pedir un
  // taxi o dentro de los ajustes no puede verse expulsado porque el servidor
  // haya contestado algo.
  useEffect(() => {
    const refrescarPapel = () => {
      if (document.visibilityState !== 'visible') return;
      void api.sesion().then((sesion) => {
        if (sesion.rol === 'cliente' && sesion.cliente) setPerfil(sesion.cliente);
        else if (sesion.rol === 'conductor' && sesion.conductor) setConductor(sesion.conductor);
      }).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', refrescarPapel);
    // Y cada pocos minutos con la aplicación delante, para el caso de quedarse
    // mirando la pantalla mientras el operador hace el cambio.
    const reloj = setInterval(refrescarPapel, 120_000);
    return () => {
      clearInterval(reloj);
      document.removeEventListener('visibilitychange', refrescarPapel);
    };
  }, []);

  // Aviso visible cuando la identidad o la ubicación vienen forzadas por la
  // URL, para que no se confunda una sesión de pruebas con una de verdad.
  const parametros = new URLSearchParams(window.location.search);
  const identidadForzada = enPruebasLocales() && parametros.has('dispositivo');
  const gpsFingido = enPruebasLocales() ? parametros.get('gps') : null;
  const cinta = identidadForzada || gpsFingido
    ? (
      <div className="cinta-pruebas">
        pruebas · {uuidDispositivo().slice(0, 8)}
        {gpsFingido && ` · gps fingido ${gpsFingido}`}
      </div>
    )
    : null;

  // Banda de «sin conexión». Va aquí arriba, fuera de cada pantalla, porque el
  // problema no es de una pantalla concreta: es que ahora mismo no se llega al
  // servidor. Lo que ya estaba en pantalla se queda —la matrícula del taxi
  // sigue siendo válida sin cobertura— en vez de vaciarse.
  const bandaSinConexion = enLinea
    ? null
    : <div className="sin-conexion">{t('conexion.sinConexion')}</div>;

  // El conmutador de papeles del operador. Para quien no es operador es null
  // y no pinta nada, así que puede ir en todas las pantallas.
  const rolActual = pantalla === 'operador'
    ? 'operador' as const
    : pantalla === 'cliente'
      ? 'cliente' as const
      : ['conductor', 'ajustes_conductor', 'estadisticas_conductor'].includes(pantalla)
        ? 'conductor' as const
        : null;
  const conmutador = <ConmutadorRol actual={rolActual} />;

  // «Mírame llegar» (migración 043): quien abre el enlace de un viaje
  // compartido. Va ANTES que todo lo demás —incluida la pantalla de carga— a
  // propósito: casi nunca es alguien que use la aplicación, así que no tiene
  // sesión que resolver ni papel que elegir, y meterle por delante «¿eres
  // pasajero o taxista?» sería absurdo cuando lo único que quiere es ver si
  // su hija ha llegado.
  const tokenSeguimiento = parametros.get('seguir');
  if (tokenSeguimiento) {
    return <>{cinta}{bandaSinConexion}<VistaSeguimiento token={tokenSeguimiento} t={t} /></>;
  }

  if (pantalla === 'cargando') {
    return <main className="lienzo">{cinta}{bandaSinConexion}<PantallaArranque texto={t('app.cargando')} /></main>;
  }

  if (pantalla === 'operador') {
    return <>{conmutador}<PanelOperador /></>;
  }

  // Trabajo de campo del agente: el mismo panel, recortado a lo suyo. Lo
  // pueden hacer un taxista agente (migración 025) y, desde la 072, también un
  // PASAJERO agente: quien mejor sitúa un barrio es a veces alguien que ni
  // conduce. Se vuelve al panel del que venía.
  if (pantalla === 'campo' && (conductor || perfil)) {
    return (
      <PanelOperador
        modo="agente"
        alVolver={() => setPantalla(conductor ? 'conductor' : 'cliente')}
      />
    );
  }

  if (pantalla === 'cliente' && perfil) {
    return (
      <>
        {cinta}
        {bandaSinConexion}
        {conmutador}
        <PanelCliente
          perfilInicial={perfil}
          puntos={puntos}
          idioma={idioma}
          alAbrirCampo={perfil.agente ? () => setPantalla('campo') : undefined}
        />
      </>
    );
  }

  if (pantalla === 'conductor' && conductor) {
    return (
      <>
        {cinta}
        {bandaSinConexion}
        {conmutador}
        <PanelConductor
          conductor={conductor}
          puntos={puntos}
          idioma={idioma}
          alAbrirAjustes={() => setPantalla('ajustes_conductor')}
          alAbrirEstadisticas={() => setPantalla('estadisticas_conductor')}
          alAbrirCampo={conductor.agente ? () => setPantalla('campo') : undefined}
          alRecargarSesion={() => { void cargarSesion(); }}
        />
      </>
    );
  }

  // Pantallas con el plano de fondo y la hoja inferior.
  return (
    <main className="lienzo">
      {cinta}
      {bandaSinConexion}
      {conmutador}
      <div className="capa-mapa"><Mapa puntos={puntos} /></div>
      <section className="hoja">
        {aviso && <p className="aviso">{aviso}</p>}

        {pantalla === 'elegir_rol' && (
          <>
            <div className="cabecera">
              <h1>{t('rol.titulo')}</h1>
              <SelectorIdioma idioma={idioma} alCambiar={cambiarIdioma} />
            </div>
            <p className="nota">{t('rol.pregunta')}</p>
            <button
              type="button"
              className="principal"
              onClick={() => {
                prepararSonido(); setAviso('');
                setRolDeAlta('cliente'); setPantalla('volver');
              }}
            >
              {t('rol.pasajero')}
            </button>
            <button
              type="button"
              className="secundario"
              onClick={() => {
                prepararSonido(); setAviso('');
                setRolDeAlta('conductor'); setPantalla('volver');
              }}
            >
              {t('rol.taxista')}
            </button>
            <p className="nota pie">{t('rol.nota')}</p>
          </>
        )}

        {pantalla === 'volver' && (
          <VolverConTelefono
            rol={rolDeAlta}
            t={t}
            alEntrar={() => { setAviso(''); void cargarSesion(); }}
            alDarDeAlta={(telefono) => {
              setAviso('');
              setTelefonoDeAlta(telefono);
              setPantalla(rolDeAlta === 'conductor' ? 'alta_conductor' : 'alta_cliente');
            }}
            alSinTelefono={() => {
              setAviso('');
              setTelefonoDeAlta(null);
              setPantalla('alta_cliente');
            }}
            alVolver={() => { setAviso(''); setPantalla('elegir_rol'); }}
            alFallar={setAviso}
          />
        )}

        {pantalla === 'alta_cliente' && (
          <AltaCliente
            t={t}
            telefono={telefonoDeAlta}
            alTerminar={() => { setAviso(''); void cargarSesion(); }}
            alFallar={setAviso}
            alVolver={() => { setAviso(''); setPantalla('volver'); }}
          />
        )}

        {pantalla === 'alta_conductor' && telefonoDeAlta && (
          <AltaConductorFormulario
            t={t}
            telefono={telefonoDeAlta}
            alTerminar={() => { setAviso(''); void cargarSesion(); }}
            alFallar={setAviso}
            alVolver={() => { setAviso(''); setPantalla('volver'); }}
          />
        )}

        {pantalla === 'ajustes_conductor' && conductor && (
          <AjustesConductor
            conductor={conductor}
            t={t}
            idioma={idioma}
            alCambiarIdioma={cambiarIdioma}
            alTerminar={() => { setAviso(''); void cargarSesion(); }}
            alFallar={setAviso}
            alVolver={() => { setAviso(''); setPantalla('conductor'); }}
          />
        )}

        {pantalla === 'estadisticas_conductor' && (
          <Estadisticas t={t} idioma={idioma} alVolver={() => setPantalla('conductor')} />
        )}

        {pantalla === 'verificar_telefono' && (
          <VerificarTelefono
            t={t}
            telefono={conductor?.telefono ?? perfil?.telefono ?? ''}
            alVerificar={() => { setAviso(''); void cargarSesion(); }}
          />
        )}
      </section>
    </main>
  );
}

// --- Pantalla de arranque ---------------------------------------------------
//
// Lo único que tarda de verdad es la primera carga: el plano (una vez, va en
// el paquete) y GET /api/sesion. Mientras tanto, el logo late en el centro
// hasta que `cargarSesion` decide qué pantalla sigue. Todo por CSS
// (transform): en un Android de gama baja cada animación cuesta (ver la nota
// de `.pulso-origen` en estilos.css), así que nada de JavaScript moviendo
// esto fotograma a fotograma.
function PantallaArranque({ texto }: { texto: string }) {
  return (
    <div className="arranque" role="status" aria-label={texto}>
      <div className="arranque-escena">
        <img className="arranque-logo" src="/icono-512.png" alt="" width={112} height={112} />
      </div>
      <p className="arranque-texto">{texto}</p>
    </div>
  );
}

// --- Verificación del teléfono por SMS (migración 027) ---------------------
//
// Puerta de entrada, no un paso del alta: se llega aquí tanto desde una
// cuenta recién creada como desde una que ya existía antes de esta migración
// y nunca confirmó su número.

const COOLDOWN_REENVIO_S = 60;

function VerificarTelefono({
  t, telefono, alVerificar,
}: { t: T; telefono: string; alVerificar: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [enviando, setEnviando] = useState(true);
  const [comprobando, setComprobando] = useState(false);
  const [error, setError] = useState('');
  const [segundosParaReenviar, setSegundosParaReenviar] = useState(COOLDOWN_REENVIO_S);

  async function enviar() {
    setEnviando(true);
    setError('');
    try {
      await api.enviarCodigoVerificacion();
      setSegundosParaReenviar(COOLDOWN_REENVIO_S);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(false);
    }
  }

  useEffect(() => { void enviar(); }, []);

  useEffect(() => {
    if (segundosParaReenviar <= 0) return;
    const reloj = setTimeout(() => setSegundosParaReenviar((s) => s - 1), 1000);
    return () => clearTimeout(reloj);
  }, [segundosParaReenviar]);

  async function comprobar() {
    setComprobando(true);
    setError('');
    try {
      await api.comprobarCodigoVerificacion(codigo);
      alVerificar();
    } catch {
      setError(t('verificacion.codigoIncorrecto'));
      setCodigo('');
    } finally {
      setComprobando(false);
    }
  }

  return (
    <>
      <h1>{t('verificacion.titulo')}</h1>
      <p className="nota">{t('verificacion.nota', { telefono })}</p>
      {error && <p className="aviso">{error}</p>}
      <input
        type="text" inputMode="numeric" autoComplete="off" maxLength={6}
        value={codigo} placeholder={t('verificacion.placeholder')}
        onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      <button
        type="button" className="principal"
        disabled={codigo.length !== 6 || comprobando}
        onClick={comprobar}
      >
        {comprobando ? t('verificacion.comprobando') : t('verificacion.comprobar')}
      </button>
      <button
        type="button" className="secundario"
        disabled={enviando || segundosParaReenviar > 0}
        onClick={enviar}
      >
        {enviando
          ? t('verificacion.enviando')
          : segundosParaReenviar > 0
            ? t('verificacion.reenviarEn', { seg: segundosParaReenviar })
            : t('verificacion.reenviar')}
      </button>
    </>
  );
}

// --- Volver a entrar con el teléfono (migración 078) -----------------------
//
// El primer paso de las dos altas, y el que faltaba: se pide el NÚMERO y nada
// más, y se mira si ya hay algo con él. Casi siempre lo hay —reinstalar la
// aplicación, cambiar de móvil o borrar los datos del navegador no borra una
// cuenta— y entonces no se pide nada más que el código del SMS. Si no hay nada,
// se sigue al formulario de siempre con el número ya puesto.
//
// POR QUÉ EL CÓDIGO NO SE PUEDE SALTAR. Lo que se entrega al volver es una
// cuenta, con el monedero y la reputación del taxista dentro. Un número de
// Malabo son nueve dígitos que empiezan casi todos igual: si bastara con
// escribirlos, las cuentas serían de quien acertase. El SMS es lo que distingue
// al dueño de la línea de quien solo conoce el número.

function VolverConTelefono({
  rol, t, alEntrar, alDarDeAlta, alSinTelefono, alVolver, alFallar,
}: {
  rol: 'cliente' | 'conductor';
  t: T;
  alEntrar: () => void;
  alDarDeAlta: (telefono: string) => void;
  alSinTelefono: () => void;
  alVolver: () => void;
  alFallar: (m: string) => void;
}) {
  const [telefono, setTelefono] = useState('');
  const [fase, setFase] = useState<'telefono' | 'codigo'>('telefono');
  // El número en forma canónica, tal como lo devuelve el servidor. Es el que
  // vale para los dos pasos siguientes: normalizarlo otra vez aquí sería tener
  // la misma regla en dos sitios, y en cuanto se separasen dejaría de encontrar
  // cuentas que sí existen.
  const [canonico, setCanonico] = useState('');
  // Registrado, pero con el OTRO papel. Es lo que pasa cuando alguien se
  // equivoca de botón en la pantalla anterior, y hay que decirlo antes de
  // mandarle a un formulario de alta que no quería.
  const [otroPapel, setOtroPapel] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [segundosParaReenviar, setSegundosParaReenviar] = useState(0);

  useEffect(() => {
    if (segundosParaReenviar <= 0) return;
    const reloj = setTimeout(() => setSegundosParaReenviar((s) => s - 1), 1000);
    return () => clearTimeout(reloj);
  }, [segundosParaReenviar]);

  async function enviarCodigo(numero: string) {
    try {
      await api.pedirCodigoCuenta(numero);
      setSegundosParaReenviar(COOLDOWN_REENVIO_S);
    } catch (error) {
      // El SMS puede no salir —cooldown, o Twilio caído— y aun así hay que
      // dejar escribir el código: puede que ya tenga uno del intento anterior.
      alFallar(mensajeDeError(error, t('verificacion.enviando')));
    }
  }

  async function comprobar() {
    setOcupado(true);
    alFallar('');
    try {
      const hallazgo = await api.buscarCuenta(telefono.trim());
      setCanonico(hallazgo.telefono);
      const miPapel = rol === 'conductor' ? hallazgo.conductor : hallazgo.cliente;
      const elOtro = rol === 'conductor' ? hallazgo.cliente : hallazgo.conductor;
      if (miPapel) {
        setOtroPapel(false);
        await enviarCodigo(hallazgo.telefono);
        setFase('codigo');
      } else if (elOtro) {
        setOtroPapel(true);
      } else {
        alDarDeAlta(hallazgo.telefono);
      }
    } catch (error) {
      alFallar(mensajeDeError(error, t('volver.titulo')));
    } finally {
      setOcupado(false);
    }
  }

  async function entrar() {
    setOcupado(true);
    alFallar('');
    try {
      await api.reclamarCuenta(canonico, codigo, rol);
      alEntrar();
    } catch (error) {
      alFallar(mensajeDeError(error, t('verificacion.codigoIncorrecto')));
      setCodigo('');
    } finally {
      setOcupado(false);
    }
  }

  if (fase === 'codigo') {
    return (
      <>
        <h1>{t('verificacion.titulo')}</h1>
        <p className="nota">{t('volver.yaEstas')}</p>
        <p className="nota">{t('verificacion.nota', { telefono: canonico })}</p>
        <input
          type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          value={codigo} placeholder={t('verificacion.placeholder')}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button
          type="button" className="principal"
          disabled={codigo.length !== 6 || ocupado}
          onClick={entrar}
        >
          {ocupado ? t('verificacion.comprobando') : t('verificacion.comprobar')}
        </button>
        <button
          type="button" className="secundario"
          disabled={ocupado || segundosParaReenviar > 0}
          onClick={() => void enviarCodigo(canonico)}
        >
          {segundosParaReenviar > 0
            ? t('verificacion.reenviarEn', { seg: segundosParaReenviar })
            : t('verificacion.reenviar')}
        </button>
        <button
          type="button" className="tenue"
          onClick={() => { alFallar(''); setCodigo(''); setFase('telefono'); }}
        >
          {t('volver.cambiarNumero')}
        </button>
      </>
    );
  }

  return (
    <>
      <h1>{t('volver.titulo')}</h1>
      <p className="nota">{t('volver.nota')}</p>
      <input
        type="tel" value={telefono} placeholder={t('campo.telefono')}
        onChange={(e) => {
          setTelefono(e.target.value);
          // Si cambia el número, lo que se averiguó del anterior ya no vale.
          if (otroPapel) setOtroPapel(false);
        }}
      />
      {otroPapel && (
        <>
          <p className="aviso">
            {t('volver.esOtroPapel', {
              papel: t(rol === 'conductor' ? 'papel.pasajero' : 'papel.taxista'),
            })}
          </p>
          <button
            type="button" className="principal"
            disabled={ocupado}
            onClick={() => alDarDeAlta(canonico)}
          >
            {t('volver.altaIgualmente')}
          </button>
        </>
      )}
      {!otroPapel && (
        <button
          type="button" className="principal"
          disabled={telefono.trim().length === 0 || ocupado}
          onClick={comprobar}
        >
          {ocupado ? t('volver.comprobando') : t('volver.continuar')}
        </button>
      )}
      {/* El pasajero puede darse de alta con solo el correo (migración 015), y
          ese camino no se puede cerrar por el paso nuevo: hay quien no tiene
          número propio. El taxista no lo tiene: su teléfono es su identidad. */}
      {rol === 'cliente' && (
        <button type="button" className="tenue" onClick={alSinTelefono}>
          {t('volver.sinTelefono')}
        </button>
      )}
      <button type="button" className="secundario" onClick={alVolver}>
        {t('accion.volver')}
      </button>
    </>
  );
}

// --- Alta del pasajero: teléfono y/o correo, nada más ----------------------

function AltaCliente({
  t, telefono, alTerminar, alFallar, alVolver,
}: {
  t: T;
  // Ya comprobado en el paso previo (migración 078), y en null cuando se eligió
  // darse de alta solo con el correo. Aquí no se vuelve a pedir ni se puede
  // cambiar: si se cambiara, el número que entra sería uno sin comprobar.
  telefono: string | null;
  alTerminar: () => void;
  alFallar: (m: string) => void;
  alVolver: () => void;
}) {
  const [correo, setCorreo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const listo = telefono !== null || correo.trim().length > 0;

  async function guardar() {
    setGuardando(true);
    try {
      await api.guardarPerfil({
        telefono,
        correo: correo.trim() || null,
      });
      alTerminar();
    } catch (error) {
      alFallar(error instanceof Error ? error.message : t('aviso.faltaContacto'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <h1>{t('altaCliente.titulo')}</h1>
      <p className="nota">{t('altaCliente.nota')}</p>
      {telefono && <p className="nota">{t('volver.numero', { telefono })}</p>}
      <input type="email" value={correo} placeholder={t('campo.correo')}
        onChange={(e) => setCorreo(e.target.value)} />
      <button type="button" className="principal" disabled={!listo || guardando} onClick={guardar}>
        {guardando ? t('accion.guardando') : t('accion.empezar')}
      </button>
      <button type="button" className="secundario" onClick={alVolver}>
        {t('volver.cambiarNumero')}
      </button>
    </>
  );
}

// --- Alta del taxista -----------------------------------------------------

function AltaConductorFormulario({
  t, telefono, alTerminar, alFallar, alVolver,
}: {
  t: T;
  // Ya comprobado en el paso previo (migración 078): este número NO está dado
  // de alta como taxista, y por eso se llega aquí. No se vuelve a pedir, y
  // cambiarlo es volver atrás: el teléfono es la identidad del conductor, y uno
  // escrito aquí de nuevo se saltaría la comprobación.
  telefono: string;
  alTerminar: () => void;
  alFallar: (m: string) => void;
  alVolver: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [correo, setCorreo] = useState('');
  const [matricula, setMatricula] = useState('');
  const [marca, setMarca] = useState('');
  const [carroceria, setCarroceria] = useState<'turismo' | '4x4'>('turismo');
  const [aireAcondicionado, setAireAcondicionado] = useState(false);
  const [seguro, setSeguro] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const listo = [nombre, matricula, marca].every((v) => v.trim().length > 0);

  async function guardar() {
    setGuardando(true);
    try {
      const respuesta = await api.altaConductor({
        nombre: nombre.trim(),
        telefono,
        correo: correo.trim() || undefined,
        matricula: matricula.trim(),
        marca: marca.trim(),
        carroceria,
        aireAcondicionado,
        seguro,
      });
      if (respuesta.aviso) alFallar(respuesta.aviso);
      alTerminar();
    } catch (error) {
      alFallar(error instanceof Error ? error.message : t('altaConductor.titulo'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <h1>{t('altaConductor.titulo')}</h1>
      <p className="nota">{t('altaConductor.nota')}</p>
      <p className="nota">{t('volver.numero', { telefono })}</p>
      <input type="text" value={nombre} placeholder={t('campo.nombreCompleto')}
        onChange={(e) => setNombre(e.target.value)} />
      <input type="email" value={correo} placeholder={t('campo.correoOpcionalSolo')}
        onChange={(e) => setCorreo(e.target.value)} />
      <input type="text" value={matricula} placeholder={t('campo.matricula')}
        onChange={(e) => setMatricula(e.target.value)} />
      <input type="text" value={marca} placeholder={t('campo.marcaModelo')}
        onChange={(e) => setMarca(e.target.value)} />
      <div className="fila">
        <button
          type="button"
          className={carroceria === 'turismo' ? 'principal' : 'secundario'}
          onClick={() => setCarroceria('turismo')}
        >
          {t('carroceria.turismo')}
        </button>
        <button
          type="button"
          className={carroceria === '4x4' ? 'principal' : 'secundario'}
          onClick={() => setCarroceria('4x4')}
        >
          {t('carroceria.4x4')}
        </button>
      </div>
      <label className="casilla">
        <input type="checkbox" checked={aireAcondicionado}
          onChange={(e) => setAireAcondicionado(e.target.checked)} />
        {t('vehiculo.aireAcondicionado')}
      </label>
      <label className="casilla">
        <input type="checkbox" checked={seguro}
          onChange={(e) => setSeguro(e.target.checked)} />
        {t('vehiculo.seguro')}
      </label>
      <button type="button" className="principal" disabled={!listo || guardando} onClick={guardar}>
        {guardando ? t('accion.enviando') : t('accion.darseDeAlta')}
      </button>
      <button type="button" className="secundario" onClick={alVolver}>
        {t('volver.cambiarNumero')}
      </button>
    </>
  );
}

// --- Ajustes del taxista --------------------------------------------------

function AjustesConductor({
  conductor, t, idioma, alCambiarIdioma, alTerminar, alFallar, alVolver,
}: {
  conductor: DatosConductor;
  t: T;
  idioma: Idioma;
  alCambiarIdioma: (i: Idioma) => void;
  alTerminar: () => void;
  alFallar: (m: string) => void;
  alVolver: () => void;
}) {
  const [nombre, setNombre] = useState(conductor.nombre);
  const [correo, setCorreo] = useState(conductor.correo ?? '');
  const [matricula, setMatricula] = useState(conductor.matricula ?? '');
  const [marca, setMarca] = useState(conductor.marca ?? '');
  const [carroceria, setCarroceria] = useState<'turismo' | '4x4'>(
    conductor.carroceria === '4x4' ? '4x4' : 'turismo',
  );
  const [aireAcondicionado, setAireAcondicionado] = useState(conductor.aireAcondicionado);
  const [seguro, setSeguro] = useState(conductor.seguro);
  const [silencio, setSilencio] = useState(estaSilenciado());
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    setGuardando(true);
    try {
      // Se reenvía el alta: el teléfono es la clave, así que actualiza en
      // lugar de duplicar.
      await api.altaConductor({
        nombre: nombre.trim(),
        telefono: conductor.telefono,
        correo: correo.trim() || undefined,
        matricula: matricula.trim(),
        marca: marca.trim(),
        carroceria,
        aireAcondicionado,
        seguro,
      });
      alTerminar();
    } catch (error) {
      alFallar(error instanceof Error ? error.message : t('accion.guardar'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <div className="cabecera">
        <h1>{t('ajustesConductor.titulo')}</h1>
        <SelectorIdioma idioma={idioma} alCambiar={alCambiarIdioma} />
      </div>
      <p className="nota">{t('ajustesConductor.telefono', { telefono: conductor.telefono })}</p>
      <input type="text" value={nombre} placeholder={t('campo.nombre')}
        onChange={(e) => setNombre(e.target.value)} />
      <input type="email" value={correo} placeholder={t('campo.correo2')}
        onChange={(e) => setCorreo(e.target.value)} />
      <input type="text" value={matricula} placeholder={t('campo.matricula')}
        onChange={(e) => setMatricula(e.target.value)} />
      <input type="text" value={marca} placeholder={t('campo.marcaModelo')}
        onChange={(e) => setMarca(e.target.value)} />
      <div className="fila">
        <button type="button" className={carroceria === 'turismo' ? 'principal' : 'secundario'}
          onClick={() => setCarroceria('turismo')}>{t('carroceria.turismo')}</button>
        <button type="button" className={carroceria === '4x4' ? 'principal' : 'secundario'}
          onClick={() => setCarroceria('4x4')}>{t('carroceria.4x4')}</button>
      </div>
      <label className="casilla">
        <input type="checkbox" checked={aireAcondicionado}
          onChange={(e) => setAireAcondicionado(e.target.checked)} />
        {t('vehiculo.aireAcondicionado')}
      </label>
      <label className="casilla">
        <input type="checkbox" checked={seguro}
          onChange={(e) => setSeguro(e.target.checked)} />
        {t('vehiculo.seguro')}
      </label>

      <button
        type="button"
        className="secundario"
        onClick={() => setSilencio(alternarSilencio())}
      >
        {silencio ? t('sonido.apagado') : t('sonido.encendido')}
      </button>

      <button type="button" className="principal" disabled={guardando} onClick={guardar}>
        {guardando ? t('accion.guardando') : t('accion.guardar')}
      </button>
      <button type="button" className="secundario" onClick={alVolver}>{t('accion.volver')}</button>
    </>
  );
}
