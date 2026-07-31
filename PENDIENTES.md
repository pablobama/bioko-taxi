# Pendientes

Cada entrada lleva su motivo. Nada de TODO sin ticket.

## Abiertos

- **[P1-02] Polígonos de zona reales.** `zona.poligono` (GeoJSON) queda a NULL:
  el despacho del paso 5 solo necesita zona y adyacencia. Los polígonos son
  trabajo de campo y se cargarán con la herramienta de administración (paso 4).

- **[P1-03] Referencias de la semilla son plausibles, no verificadas.** Los
  nombres, alias y coordenadas de `scripts/datos-prueba.ts` sirven para probar;
  el catálogo real de Malabo se construirá en campo con la herramienta del
  paso 4.

- **[P1-04] Materialización del saldo.** `saldo_monedero` es una vista sobre
  `SUM(apunte.importe_xaf)`. Si el rendimiento lo exige se materializará
  (la espec lo permite); no antes de tener medidas reales.

- **[P6-01] Adaptador FCM sin probar contra un proyecto Firebase real.** El
  código está completo (mensaje de datos, prioridad alta, token del último
  dispositivo del conductor) y sin credenciales falla ruidosamente, pero no se
  ha enviado ningún mensaje real. Se probará en el paso 8 con la app Android y
  un proyecto Firebase de verdad.

- **[P7-01] Prueba real en Chrome Android con 2G.** El criterio de aceptación
  del paso 7 pide red 2G simulada en Chrome Android. El paquete pesa 49 KB
  gzip (objetivo < 1 MB) y el flujo completo está verificado en navegador de
  escritorio; falta la prueba en un dispositivo real de gama baja.

- **[P7-02] Sin service worker todavía.** La PWA carga por red en cada
  apertura (49 KB). Un service worker con caché del cascarón la haría abrir
  sin conexión; se valorará tras medir en el piloto.

- **[P7-03] Valoración del cliente (C6) sin interfaz.** El enrutamiento la
  define como «diferida a próxima sesión», pero la PWA aún no pide valoración
  al reabrir tras un viaje completado. Pendiente para el paso 9/10, junto con
  la reputación visible del conductor.

- **[P8-01] Aceptación del paso 8 pendiente de dispositivo real.** El criterio
  («recibe broadcast con la pantalla apagada y la app en segundo plano»)
  exige un teléfono Android físico y un proyecto Firebase real con
  `google-services.json`. El código está completo (FCM prioridad alta +
  foreground service + heartbeat de 60 s) y la API del conductor está probada
  de punta a punta, pero esa verificación no puede hacerse en esta máquina.

- **[P8-02] Firma de reparto sin generar.** El APK de release necesita un
  almacén de claves que debe crearse UNA vez y conservarse (misma firma en el
  APK directo y en Play Store después). Instrucciones en el README; generar el
  `.jks` cuando empiece el reparto y guardarlo fuera del repositorio.

- **[P8-03] La app muestra una oferta a la vez.** Si a un conductor le llegan
  varias solicitudes (no puede: el estado OFERTADO lo impide por diseño), la
  interfaz enseña la primera. Simplificación consciente alineada con la regla
  «un conductor OFERTADO no recibe otra oferta».

- **[P12-01] `banda_precio` se quedó sin fuente de datos.** Al eliminar el
  reporte de precio (migración 012) las bandas ya no pueden calcularse. El
  conductor sigue viéndolas en el broadcast (R2: no aceptar a ciegas), pero
  ahora las tiene que rellenar el operador a mano por par de zonas. Falta esa
  pantalla en el panel del paso 9; hasta entonces el broadcast dice «sin
  precio orientativo de esta ruta todavía».

- **[P12-02] Sin precios no hay detección de abuso de tarifa.** La regla R5
  contemplaba detectar conductores con divergencia sistemática de precio. Ya
  no es posible; el control queda en las valoraciones del pasajero (pendiente
  P7-03) y en las incidencias que abra el operador.

- **[P12-03] Las pruebas y las pruebas manuales comparten base de datos.** La
  batería deja solicitudes a medias que el planificador ofrece a los
  conductores de la semilla, dejándolos OFERTADO y rompiendo la siguiente
  prueba manual. Paliativo: `npm run limpiar`. Arreglo de verdad: base de
  datos separada para las pruebas (o esquema propio por ejecución).

- **[P13-01] La recogida automática por GPS se degrada con varios pasajeros.**
  Con dos personas esperando cerca del coche la proximidad no identifica a
  ninguna: hay una guarda de ambigüedad que, en ese caso, NO marca a nadie y
  deja decidir al botón del conductor. Consecuencia honesta: cuanto más se
  comparte el taxi, menos veces acierta la recogida automática. El cierre por
  separación no sufre este problema (cada pareja se evalúa aparte).

- **[P13-02] Un conductor solo recibe una oferta a la vez.** Si va llenando el
  coche, cada plaza se ofrece en un tique distinto del planificador (hasta 5 s
  entre una y otra). Es deliberado —evita que reclame dos asientos a la vez y
  que la máquina de estados tenga que gestionar ofertas paralelas— pero hace
  que llenar un coche de 4 tarde unos segundos más de lo necesario.

- **[P13-03] Carrera entre planificador y API al ofertar.** Si `iniciarDespacho`
  (petición del cliente) y `avanzarDespachos` (planificador) intentan ofertar al
  mismo conductor a la vez, la segunda transacción falla con
  ErrorTransicionInvalida (OFERTADO → OFERTADO) y su solicitud puede quedarse
  sin oferta hasta el tique siguiente. Con taxi compartido la ventana es mayor
  porque los conductores pasan más tiempo DISPONIBLE. No se pierde nada, pero
  conviene tratarlo como conflicto esperado y no como error.

- **[P13-04] Sin límite de desvío.** El sistema empareja por zona de destino,
  no por ruta: puede juntar a dos pasajeros cuyos destinos están en la misma
  zona pero en extremos opuestos de ella. Sin datos de rutas reales no hay
  forma barata de acotarlo; se revisará con el piloto.

- **[P17-01] El plano compilado se queda anticuado.** Las calles vienen de un
  fichero generado (`npm run compilar-mapa`) que viaja dentro de la app: si
  OpenStreetMap gana detalle en Malabo, hay que volver a compilar y publicar.
  A cambio: 55 KB comprimidos una sola vez, funciona sin conexión y desaparece
  el problema de la política de baldosas de OSM. Conviene recompilarlo cada
  pocos meses.

- **[P17-02] No he podido verificar visualmente el plano.** El panel de
  navegador que uso no compone fotogramas (`document.hidden`), y el
  renderizador de lienzo de Leaflet dibuja dentro de `requestAnimationFrame`.
  Sé que se añaden las 3.756 vías con coordenadas correctas, pero **no he
  visto los píxeles**. Hay que mirarlo en un navegador de verdad. Si no
  apareciera, el atributo `data-vias-dibujadas` del contenedor dice cuántas
  vías se añadieron.

- **[P17-03] El panel del taxista en la web es para probar, no para
  repartir.** Existe para ver el sistema completo en localhost. Los conductores
  reales deben usar la app Android (`android/`), que tiene FCM y servicio en
  primer plano: la web no recibe avisos con la pantalla apagada.

- **[P20-01] Las rutas y los sentidos únicos** — parcialmente resuelto el
  2026-07-29: el plano (versión 3) trae la etiqueta `oneway` de OSM (466 vías
  de sentido único en Malabo, rotondas incluidas) y el grafo la respeta, con
  reintento de rescate si los datos no dejan ningún camino legal. Sigue sin
  haber giros prohibidos ni semáforos: sigue siendo guía visual, no
  navegación paso a paso.

- **[P20-02] El tiempo estimado sigue usando la línea recta.** Ahora que hay
  ruta por carretera podría calcularse sobre su distancia real, que es bastante
  más fiel que la recta × 1,3 de hoy. No se ha hecho porque el cálculo vive en
  el servidor y la ruta en el cliente: habría que mover el enrutador al
  servidor o que el cliente envíe la distancia.

- **[P20-03] «noop» finge entregar y esconde eventos perdidos.** Fue la causa
  de que el taxista no viera las carreras: sus avisos estaban enrutados a noop
  desde un apaño de desarrollo, y noop informa de éxito sin hacer nada, así
  que el bus nunca escalaba al canal siguiente. Debería registrarse como
  «suprimido» —igual que una regla con canal_1 nulo— o desaparecer, en lugar
  de parecer una entrega buena en `evento_salida`.

- **[P18-01] Ningún pago se verifica: la confirmación es un acto de fe del
  operador.** No hay integración con Muni Dinero ni con ningún banco. El
  conductor pide la recarga, la app le da una referencia, él paga por su
  cuenta, y una PERSONA mira la cuenta y confirma. Confirmar sin haber visto
  el dinero es regalar saldo, y nada en el sistema lo impide. Si Muni Dinero
  publicara una API o exportara movimientos, casar la referencia sería
  automático; hoy no.

- **[P18-02] El taxista no se entera de que le han confirmado la recarga.** El
  saldo sube y lo ve la próxima vez que abre la app, pero no recibe aviso. Con
  FCM funcionando sería un evento más (como D5, que ya está en la tabla de
  enrutamiento pero nadie emite).

- **[P18-03] Las recargas caducadas no se caducan solas.** Hay orden
  (`npx tsx scripts/recargas.ts caducar`) pero nada la ejecuta: falta meterla
  en el planificador o en una tarea programada.

- **[P17-05] Cambiar de rol exige tocar la base de datos.** Un dispositivo
  registrado como pasajero no puede pasar a taxista ni al revés (da 409). Es
  deliberado —el historial y los strikes cuelgan del dispositivo— pero no hay
  forma de deshacerlo salvo borrar el registro a mano.

- **[P17-06] Los avisos sonoros necesitan un toque previo del usuario.** Los
  navegadores no dejan sonar nada antes de una interacción. Se desbloquea en
  el primer botón que se pulsa (elegir rol, pedir taxi, entrar en servicio),
  así que en la práctica está resuelto, pero si alguien deja la app abierta sin
  tocarla no oirá el primer aviso. Por eso ningún aviso importante depende solo
  del sonido.

- **[P15-04] El registro sigue SIN ser autenticación, aunque el teléfono ya
  sea único.** Desde la migración 024 el número es la clave de identidad —
  canónico, único por papel y unido al dispositivo que lo tiene ahora— y las
  sanciones lo siguen: reinstalar ya no limpia un bloqueo, que era la puerta
  de atrás. Pero **nadie verifica el número**: no se manda ningún código. Así
  que el teléfono es una LLAVE (te devuelve tu cuenta), no una PRUEBA (no
  demuestra que sea tuyo). Consecuencias que hay que tener presentes:
  - Quien teclee el número de otro se lleva sus sanciones, que es un castigo
    y no un premio: por ahí no hay incentivo. Pero sí puede conseguir que
    bloqueen a un inocente. El operador puede desbloquear, así que es
    reversible.
  - El historial de viajes NO se hereda al reclamar un número, a propósito: si
    viajara, cualquiera que conozca tu teléfono vería a dónde sueles ir con
    solo teclearlo. Coste asumido: al reinstalar, «tus destinos de siempre»
    empiezan de cero aunque el bloqueo te siga.
  - Compartir teléfono (normal en Malabo) ahora significa que la cuenta se la
    queda quien lo declaró último; el anterior conserva su fila y su historial
    pero deja de tener el número vigente. Si molesta en el piloto, la salida
    es una pantalla del operador para separarlos.
  Si hace falta identidad de verdad, lo barato sigue siendo un código por
  correo con SMTP propio (sin coste por mensaje); por SMS costaría dinero y lo
  prohíbe la decisión 3.1.

- **[P15-05] Se guardan edad y género sin haber definido para qué.** Son
  opcionales y el usuario puede no decirlos, pero recoger datos personales sin
  un uso concreto es deuda: o se decide para qué sirven (seguridad de mujeres
  conductoras, informes) o se dejan de pedir.

- **[P14-02] El tiempo estimado no usa rutas.** Es línea recta × 1,3 dividida
  por 18 km/h (parámetros `eta_factor_desvio` y `velocidad_urbana_kmh`). En
  Malabo, con tráfico y calles que no siguen la recta, se equivocará. La
  interfaz dice «aprox.» y los dos números se ajustan sin desplegar cuando
  haya datos de viajes reales para calibrarlos.

- **[P14-03] El cliente ve la posición del conductor.** Antes no la veía.
  Solo durante ACEPTADO, EN_CAMINO y RECOGIDO, y solo la última lectura. Es
  necesario para el mapa de aproximación, pero es una divulgación nueva que
  conviene contarle al conductor en su alta.

- **[P14-04] La reputación no afecta todavía al despacho.** Se muestra al
  cliente pero `prioridad_despacho` sigue sin calcularse a partir de ella:
  eso es el paso 10. Un conductor con malas notas hoy recibe lo mismo.

- **[P5-02] La re-emisión no reoferta a quien ya tuvo oferta.** Tras la
  reasignación de R3 (`ACEPTADO → EMITIDO`), el índice único
  `oferta(solicitud_id, conductor_id)` impide volver a ofertar la misma
  solicitud a conductores que ya la tuvieron (perdida/expirada/rechazada).
  Ventaja: no se molesta dos veces; coste: en zonas pequeñas la re-emisión
  puede quedarse sin candidatos. Decidir con datos reales si conviene relajar.

- **[P21-01] Panel de operador — segunda versión (2026-07-30).** Cinco
  secciones: Resumen (números con contadores de trabajo pendiente),
  Incidencias (la cola de revisión manual, con perdonar/sancionar y el log
  de transiciones del viaje), Conductores (búsqueda por nombre/teléfono/
  matrícula y ficha completa: vehículo, saldo, suscripción, reputación,
  historial, recargas), Pasajeros (búsqueda, ficha con strikes y viajes,
  desbloquear) y Pagos (confirmar/rechazar recargas). Tercera versión
  (2026-07-30, bloques 1/4/5/6 de la propuesta): cuadro de mandos con las
  cinco alarmas `alarma_*` evaluadas (por fin tienen consumidor; la de
  mensajería queda declarada «sin fuente de datos»), central telefónica
  (pedir taxi en nombre de quien llama, con dispositivo sintético por
  teléfono e idempotencia), editor del gazetteer (crear/editar/desactivar
  sitios y alias, viendo también las inactivas), bandas de precio por par
  de zonas y edición de parámetros del sistema. Sigue pendiente:
  - Cambiar el rol de un dispositivo (cliente ↔ conductor): el esquema exige
    hoy que `tipo` no sea NULL y las solicitudes cuelgan del dispositivo;
    pide diseño propio, no un simple UPDATE.
  - Paginación de verdad en las listas (hoy LIMIT 100-200).
  - El alta de conductor sigue naciendo `verificado` sin revisión (decisión
    explícita del 2026-07-28, «por ahora»): con la verificación ya cómoda en
    el panel, decidir si vuelve a nacer `pendiente`.

- **[P21-02] Las llamadas necesitan un TURN configurado para conectar entre
  redes móviles.** Sin puente, dos teléfonos detrás del NAT de su operador no
  pueden verse y la llamada acaba en «No se pudo conectar» (el código lo dice
  en vez de dejar el «llamando…» eterno, pero no conecta). El servidor acepta
  dos configuraciones: coturn propio (`TURN_URL` + `TURN_SECRETO`, ver
  `infraestructura/turn/LEEME.md`) o un TURN alquilado con credenciales fijas
  (`TURN_URL` + `TURN_USUARIO` + `TURN_CLAVE`), suficiente para el piloto.
  Hasta que una de las dos esté puesta en Render, las llamadas solo conectan
  entre dispositivos que pueden verse directamente (misma red, o NAT
  benigno).

- **[P22-01] Taxis en vivo en el mapa del pasajero.** Pedido el 2026-07-30:
  al abrir la app, el pasajero debería ver los taxis EN SERVICIO de su zona
  moviéndose por el plano (como hacen las grandes apps de VTC). Hoy el mapa
  solo enseña el taxi propio cuando ya hay viaje. Requiere: un endpoint que
  dé las posiciones recientes de los conductores DISPONIBLES de la zona (sin
  identificarlos: puntos anónimos), refresco periódico o SSE, y cuidado con
  la privacidad del conductor (posición redondeada o retrasada, nunca su
  identidad). El heartbeat ya guarda posición, así que los datos existen.

- **[P22-02] Pasajeros en vivo en el mapa del taxista.** Pedido el
  2026-07-30, el espejo de P22-01: el taxista debería ver a los usuarios
  activos de su zona moviéndose por el plano, dibujados con forma de persona
  (muñeco) en color ROJO. Ojo, aquí la privacidad pesa más todavía: la
  posición del pasajero solo se conoce mientras la app está abierta
  (enviarPosicion existe solo durante un viaje activo hoy), así que haría
  falta que la PWA del pasajero comparta posición también en reposo — eso
  pide consentimiento explícito, anonimato total (puntos sin identidad, con
  redondeo) y apagarse solo al cerrar la app. Valorar si de verdad compensa
  frente a enseñar solo «cuánta gente pide en cada zona» (calor por zonas,
  sin puntos individuales).

- **[P23-01] El filtro de saldo de R5 nunca se aplicó al emitir.**
  `tieneSaldoParaComision()` existe en `monedero.ts`, tiene prueba propia y su
  comentario dice «filtro de emisión (R5)», pero `despacho.ts` no la llama:
  hoy un conductor sin saldo para la comisión recibe carreras igual. Salió al
  escribir `cobertura.ts`, que replica los filtros del reparto y tuvo que
  decidir si copiar el que no está. Se dejó fuera a propósito para que el
  conteo se parezca a lo que el reparto hace de verdad; el día que se aplique
  hay que aplicarlo en los dos sitios a la vez o el pasajero verá taxis
  fantasma. Decidir si es un olvido o una decisión no escrita: cambiar quién
  recibe carreras no es un arreglo que se cuele en otra tarea.

- **[P22-01] Taxis en vivo en el mapa del pasajero** — resuelto de otra forma
  el 2026-07-30, y a propósito: en vez de puntos que se pueden seguir, un
  CONTEO por zona (migración 023). El razonamiento completo está en esa
  migración y en la evaluación de esa fecha; en resumen, un punto seguible es
  una herramienta de acoso y de robo, el anonimato del punto es falso cuando
  en el barrio solo hay dos taxis, y enseñar un taxi a cien metros invita a
  pararlo en la calle, donde la plataforma no cobra comisión. Los puntos
  individuales quedan condicionados a que exista verificación de identidad
  real (P15-04), consentimiento informado del taxista en su alta (P14-03) y
  evidencia de que la fuga a la calle no es material.

- **[P22-02] Pasajeros en el mapa del taxista** — resuelto de otra forma el
  2026-07-30: demanda AGREGADA por barrio, nunca pines. Un pin diría «una
  persona, sola, en esta dirección, ahora mismo» a un colectivo que hoy se
  auto-verifica sin que nadie revise nada (P21-01). Los pines individuales de
  pasajero quedan descartados, no aplazados.

- **[P23-02] La fuga a la calle no se puede medir directamente.** Un viaje
  pactado en la calle es invisible para la plataforma por definición. El
  proxy que hay que instrumentar es «vio el conteo y no pidió»: si sube mucho,
  el conteo está sirviendo para encontrar taxis fuera de la aplicación. Hoy no
  se registra nada de eso.

- **[P25-01] Un agente de campo puede cambiar precios sin dejar rastro.** El
  papel de agente (migración 025) permite fijar las bandas de precio entre
  zonas, y esos cambios no se registran en ninguna parte: no se sabe quién los
  hizo ni cuándo. Con dos o tres agentes de confianza no es urgente, pero es
  el tipo de cosa que solo se echa de menos cuando ya pasó. El operador puede
  retirar el papel, así que el daño se corta; reconstruir lo que se tocó, no.

- **[P25-02] La precisión del GPS** — resuelto el 2026-07-30. El teléfono
  espera a fijar (`watchPosition`, mostrando cómo mejora) en vez de coger la
  primera lectura, el servidor exige `coords.accuracy` y rechaza por encima
  del parámetro `gps_precision_maxima_m` (50 m, editable desde Ajustes), y la
  precisión se guarda en `zona.precision_gps_m` para poder repetir después los
  dudosos. Los barrios cargados por el importador la tienen a NULL: no se
  sabe con qué precisión se tomaron, y fingir un número sería peor.

## Resueltos

- **[P27-01] Verificación de teléfono por SMS (Twilio Verify)** — resuelto el
  2026-07-31, y revierte la decisión 3.1 (SMS prohibido por coste): probado en
  producción que Twilio Verify entrega a Guinea Ecuatorial sin registro A2P
  10DLC (a diferencia de un número normal de mensajería) y el coste aceptado
  tras revisar el precio. Migración 027: `telefono_verificado_en` en
  `conductor` y `perfil_cliente`, un servicio inyectable
  (`ServicioVerificacionTwilio` / `ServicioVerificacionConsola` en desarrollo
  sin credenciales) y dos rutas (`/api/verificacion/enviar`,
  `/api/verificacion/comprobar`). Se exige a TODOS los usuarios, no solo a
  conductores; las cuentas ya existentes lo ven la próxima vez que abren la
  app (sin migración retroactiva de datos: toda fila queda `NULL`, que ya es
  «sin verificar»). Un pasajero que solo dio correo (migración 015) queda
  exento — no hay teléfono al que mandar nada.
  Esto **no cambia** la mecánica de reclamar un número (`telefono_vigente`,
  migración 024) descrita en [P15-04]: sigue siendo el mismo dispositivo el
  que se queda con el número al escribirlo. Lo que cambia es que ahora, para
  que ese dispositivo pueda USAR la app, alguien tiene que haber recibido y
  tecleado el código de ESE número — lo que hace mucho más difícil que
  escribir el teléfono de otro sirva de algo, aunque el operador seguía
  siendo la salvaguarda última (desbloquear a quien resulte inocente).

- **[P5-01] Entrega de eventos tras el commit** — resuelto en el paso 6 con
  el patrón outbox: el dominio escribe en `evento_salida` dentro de su misma
  transacción y el despachador entrega después del commit. Un rollback hace
  desaparecer el evento (probado).

- **[P1-01] Transiciones añadidas a la tabla 5.2** — confirmado el 2026-07-26:
  `SOLICITADO → SIN_OFERTA (sistema)` para la zona vacía de R1 y
  `ACEPTADO → EMITIDO (sistema)` para la reasignación automática de R3 quedan
  como transiciones válidas oficiales.

## Notas de entorno (no son deuda)

- La máquina de desarrollo es Windows ARM64; los binarios de PostgreSQL 16
  (`@embedded-postgres/windows-x64`, instalado con `--force`) corren bajo la
  emulación x64 de Windows. En producción (VPS) será un PostgreSQL 16 normal.
- El paquete de binarios no incluye `psql`; para consultas ad hoc está
  `servidor/scripts/consulta.ts`.
