# Pendientes

Cada entrada lleva su motivo. Nada de TODO sin ticket.

## Abiertos

- **[P62-01] El orden de paradas es voraz, no el mejor posible.** Con taxi
  compartido, lo siguiente es la parada más cercana por las calles, y desde
  ella otra vez la más cercana. El orden ÓPTIMO (el problema del viajante) con
  cuatro plazas son 40.320 combinaciones, cada una midiendo caminos por el
  grafo: no compensa para cuatro paradas. El voraz acierta en lo que importa
  —no cruzar la ciudad con alguien dentro que se baja al lado— pero puede
  equivocarse en un caso concreto: tres paradas en triángulo donde ir primero
  a la más cercana obliga a volver sobre los propios pasos.

- **[P58-02] La guía por voz no dice nombres de calle.** Dice el giro y la
  distancia («en doscientos metros, gira a la derecha») porque el plano guarda
  geometría y clase de vía, no rótulos. El nombre está en OSM y se podría
  meter al compilar el plano, a costa de tamaño: el fichero son ya 513 KB y
  los nombres no comprimen tan bien como las coordenadas. Antes de pagarlo,
  merece la pena preguntar a un taxista si le sirve de algo.

- **[P57-04] La cola sin red de Android no se ha probado en un teléfono.**
  El código está (`ColaAcciones`, 24/09) y el APK compila, pero lo único que se
  ha comprobado de verdad es que compila: aquí no hay ni teléfono ni forma de
  cortarle la cobertura a un emulador y ver qué hace el servicio en primer
  plano. La lógica es la misma que la de la PWA, que sí está probada
  (`sinRed.prueba.ts`, cinco pruebas) y verificada en el navegador. Lo que hay
  que probar en la calle, en este orden: pulsar «pasajero recogido» en modo
  avión y ver que la pantalla avanza y aparece «1 por enviar»; volver a tener
  red y ver que el viaje queda con la hora del clic, no la de la reconexión; y
  lo mismo con la pantalla bloqueada, que es para lo que existe esta app.

- **[P57-02] El panel del operador no funciona sin red.** Ni guarda lo último
  que vio ni sus acciones esperan. Es un puesto de trabajo que normalmente
  tiene conexión, así que se dejó para después; si el operador trabaja desde
  el móvil en la calle, habrá que hacerlo.

- **[P57-03] Pedir, aceptar y cancelar necesitan red, a propósito.** No es un
  hueco: una petición que sale veinte minutos tarde manda un taxi a quien ya
  se fue, una aceptación tardía le quita la carrera a otro taxista, y una
  cancelación tardía llega con el taxista en la puerta. La aplicación lo dice
  claro. Si algún día se quiere «pedir en cuanto haya red», tiene que llevar
  una caducidad corta y explícita, y decírselo al pasajero.

- **[P55-01] Render en plan gratuito se DUERME, y con él todo lo automático.**
  `render.yaml` dice `plan: free`: sin peticiones durante 15 minutos el
  servicio se apaga, y un `setInterval` no corre en un proceso apagado. Se vio
  en el primer informe de producción: un turno cuya última señal fue el 13/09
  a las 13:50 se dio por abandonado el 14/09 a las 08:57:48 —diecinueve horas
  después en vez de doce—, SEIS SEGUNDOS antes de la siguiente petición, la de
  volver a entrar en servicio. Es decir, el planificador no corrió en toda la
  noche. Lo mismo vale para las oleadas del reparto, el cierre y la caducidad
  de viajes y la renovación de suscripciones: con la ciudad tranquila, nada de
  eso pasa hasta que alguien abre la aplicación. Con tráfico real de día quizá
  no se note, pero una petición de taxi a las cinco de la mañana despierta un
  servidor que tarda de treinta a sesenta segundos en arrancar. Arreglarlo es
  un plan de pago (el más pequeño no se duerme) o un vigilante externo que lo
  llame cada pocos minutos; es decisión de dinero, no de código.

- **[P55-02] El recorrido del iPhone del operador: un 5 % grabado.** El 14/09,
  de 3 h de servicio se grabaron 9 minutos: el segundo turno (12:38–15:28)
  tiene un único punto, el de entrar. El teléfono del operador es un iPhone y
  la app nativa es solo Android, así que es casi seguro P47-01 — pero «casi
  seguro» no es saberlo, y hasta la migración 055 no había forma de saberlo.
  Ahora sí: el siguiente turno con hueco lo explicará en el informe.

- **[P53-01] La velocidad medida es del coche, no de la carretera que falta.**
  El tiempo de llegada usa lo que el taxi ha andado en los últimos seis
  minutos, y eso da por hecho que lo que viene se parece a lo que acaba de
  pasar. Casi siempre es verdad y es muchísimo mejor que una constante, pero
  falla en el caso claro: un taxi que sale de un atasco del centro hacia una
  avenida despejada seguirá contando a velocidad de atasco durante unos
  minutos. El suelo y el techo (8 y 100 km/h) evitan lo peor. Arreglarlo de
  verdad es saber por qué calles va a pasar, o sea P52-05.

- **[P52-05] El tiempo de llegada sigue sin motor de rutas.** La 052 lo parte
  en tramo urbano y de carretera y la 053 mide la velocidad real del coche,
  pero la DISTANCIA sigue siendo una línea recta por un factor. No sabe de la carretera de Luba ni del
  desvío de Riaba, así que un trayecto que rodee mucho se quedará corto. Con
  las carreteras de Bioko ya compiladas en el plano (`mapa-malabo.json`), el
  camino natural es calcular la ruta de verdad con el mismo grafo que ya usa la
  PWA para dibujarla, y medir sobre ella.

- **[P52-01] La app nativa y la PWA son dos aplicaciones distintas del mismo
  taxista.** La app Android tiene su propia pantalla en Kotlin —botones planos,
  sin mapa, sin velocímetro, sin brújula— mientras que todo el trabajo reciente
  de interfaz está en la PWA. El taxista que instale el APK para que se le
  grabe el recorrido con el móvil en el bolsillo PIERDE el plano, la ruta y la
  velocidad; el que use la PWA los tiene pero solo graba con la pantalla
  encendida. Hay que elegir, y la salida buena es que la app sea un WebView de
  la PWA con el servicio en primer plano nativo por debajo: una sola interfaz,
  que además se actualiza al desplegar sin pasar por ninguna tienda. Lo que
  hay que resolver antes es la identidad, que hoy es un UUID en el
  almacenamiento del navegador y en el WebView sería otro distinto — el
  registro por teléfono de la app ya da el camino, pero hay que unirlo.

- **[P52-02] La app nativa no está probada en un teléfono.** Compila y el
  razonamiento está escrito, pero nada de esto —el GPS con la pantalla
  bloqueada, la cola en disco, la subida por lotes— se ha visto funcionar en un
  Android de verdad. Es exactamente lo que hay que hacer antes de repartir
  ningún APK: entrar en servicio, bloquear la pantalla, dar una vuelta a la
  manzana con el móvil en el bolsillo y mirar el recorrido en el panel del
  operador. Y repetirlo en modo avión para ver que sube al volver.

- **[P52-03] iPhone sigue sin solución.** Todo esto es Android. En iOS solo una
  app nativa firmada y repartida por la App Store puede pedir ubicación en
  segundo plano, y eso son cuenta de desarrollador, un Mac para compilar y
  revisión de Apple. Mientras tanto, un taxista con iPhone graba su recorrido
  solo con la aplicación delante (P47-01).

- **[P51-01] «Al volante» mide lo que se ve, no lo que pasó.** El tiempo en
  movimiento se calcula sobre los puntos del rastro, y el rastro tiene un
  punto cada 45 s como mucho. Un semáforo de 40 s cae dentro de un salto que
  cuenta entero como conducción, y un tramo perdido por batería no cuenta
  nada. Es una estimación buena para comparar días y turnos, que es para lo
  que se puso, pero no vale para liquidar nada a nadie. Si algún día hiciera
  falta esa precisión, el sitio es la velocidad del propio GPS
  (`coords.speed`), que el móvil ya lee para el velocímetro y hoy se tira.

- **[P51-02] Cambiar la hora del móvil corre el recorrido de sitio.** El envío
  diferido acepta la hora que dice el teléfono, y solo comprueba dos cosas:
  que caiga dentro de un turno que existió de verdad y que no sea del futuro
  ni más vieja que la retención. Alguien que atrase su reloj puede colocar sus
  puntos en otro momento DE SU PROPIO TURNO. No permite inventarse turnos ni
  tocar los de otro, así que el daño posible es pequeño; arreglarlo del todo
  pide que el móvil mande también su reloj y el desfase con el servidor, y no
  parece que compense todavía.

- **[P50-01] El cierre automático tarda ahora hasta minuto y medio más.** La
  migración 050 exige que la separación aguante `gps_separacion_sostenida_seg`
  (90 s) antes de dar el viaje por terminado. Es el precio de no volver a
  cerrar un viaje con el pasajero dentro, y se paga a gusto, pero conviene
  mirar en producción cuántos cierres se retrasan y cuántos acaban
  cerrándolos el taxista a mano antes de que salte el automático. Si resulta
  que el botón siempre gana, el automático sobra y hay que decirlo.

- **[P50-02] La pantalla nueva sin probar en un teléfono de verdad.** El plano
  pasa a ocupar la pantalla entera, la hoja flota encima y los mandos van en
  una columna a la izquierda. Está visto en la galería y en el navegador del
  escritorio, no en un móvil en la calle: falta comprobar que la columna no
  se pisa con el conmutador de papeles en pantallas estrechas, que el botón
  de recoger la hoja se alcanza con el pulgar conduciendo, y que la hoja
  recogida no deja al pasajero sin saber dónde estaba el botón de pedir.

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

- **[P18-01] Ningún pago se verifica de verdad, pero ya no se confirma a
  ciegas.** Sigue sin haber integración con Muni Dinero ni con ningún banco: el
  dinero no pasa por aquí y quien dice que el pago llegó es una persona mirando
  una cuenta. Lo que cambió el 2026-09-25 (migración 068) es que esa
  afirmación dejó de ser anónima e irrepetible: al confirmar hay que escribir
  el COMPROBANTE del pago —el identificador de la transferencia, o el número
  del recibo—, y el mismo comprobante NO puede confirmar dos recargas (índice
  único). Un pago, un saldo; y cualquiera puede cotejar después contra el
  extracto. Queda pendiente lo de siempre: si Muni Dinero publicara una API o
  exportara movimientos, casar la referencia sería automático. También queda
  sin hacer el doble par de ojos para importes grandes — con un solo operador
  bloquearía el trabajo, así que se deja escrito en vez de implementado.

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

- **[P15-04] Sigue sin ser una cuenta, aunque ya no baste con saber tu uuid.**
  Resuelto lo peor el 2026-09-25 (migración 069): cada dispositivo tiene un
  secreto de 32 bytes que el servidor entrega una vez, guarda en hash y exige
  en cada petición. Antes, quien conociera el uuid ERA esa persona —y el uuid
  viaja en la URL del SSE, así que acaba en los registros de cualquier proxy—.
  Lo que sigue abierto, y no lo arregla ningún código: esto no es una cuenta.
  No hay contraseña ni recuperación, y un teléfono en manos de otro es la
  sesión de su dueño, igual que su WhatsApp. El número verificado (migración
  027) es lo que permite recuperar la identidad en un teléfono nuevo; el
  secreto solo impide que alguien se cuele en la sesión que ya existe.
  **Compatibilidad:** el secreto se exige solo a quien tiene uno emitido, y
  solo se emite cuando el cliente lo pide. Una aplicación vieja sigue
  funcionando igual — y eso significa que un taxista que no actualice se queda
  con la protección antigua: conviene mirar en producción cuántos dispositivos
  siguen sin secreto pasadas unas semanas.

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

- **[P25-02] La precisión del GPS** — resuelto el 2026-07-30. El teléfono
  espera a fijar (`watchPosition`, mostrando cómo mejora) en vez de coger la
  primera lectura, el servidor exige `coords.accuracy` y rechaza por encima
  del parámetro `gps_precision_maxima_m` (50 m, editable desde Ajustes), y la
  precisión se guarda en `zona.precision_gps_m` para poder repetir después los
  dudosos. Los barrios cargados por el importador la tienen a NULL: no se
  sabe con qué precisión se tomaron, y fingir un número sería peor.

- **[P47-01] En iPhone el recorrido solo se graba con la app abierta y la
  pantalla encendida.** No es un fallo que se pueda arreglar aquí: iOS suspende
  el JavaScript de una PWA en cuanto se bloquea la pantalla o se cambia de
  aplicación, y no da geolocalización en segundo plano a nada que no sea una
  app nativa. Sin latido no hay `rastro`. Consecuencias prácticas: el recorrido
  de un taxista con iPhone saldrá troceado —un tramo por cada rato que tuvo la
  app delante—, y las decisiones automáticas de recogida y cierre tampoco
  reciben su posición mientras esté en segundo plano. En Android la PWA aguanta
  bastante mejor, pero tampoco es eterna. La única solución de verdad es una
  app nativa; mientras tanto conviene saberlo antes de sacar conclusiones de un
  recorrido con agujeros.
  La migración 051 arregla la MITAD del problema: el móvil apunta el recorrido
  por su cuenta y lo sube al volver la red, así que un agujero de cobertura ya
  no es un agujero en el recorrido. Lo que sigue sin arreglo es el otro medio,
  que es este: con la pantalla bloqueada no se ejecuta nada, así que no hay ni
  siquiera lectura que apuntar.

- **[P46-04] El mapa del pasajero se envía recortado y eso empeora el nombre
  del sitio.** `/api/mapa` tiene un tope de 800 referencias y el catálogo ya va
  por 2.249 tras la importación de OpenStreetMap: el servidor manda las 800 más
  usadas y lo avisa por el registro. La PWA deduce el nombre del origen
  buscando el punto más cercano DE ESA LISTA, así que puede acabar nombrando un
  sitio lejano teniendo uno al lado que no viajó. Con la migración 046 el punto
  de recogida ya no depende de esto —va la coordenada real—, pero el nombre que
  lee el taxista sí. Se arregla mandando también los cercanos al GPS, no solo
  los más usados.

- **[P52-04] La posición en vivo del pasajero solo la usa el plano.** Resuelto
  a medias lo que era P46-01: el pin del taxista ya se mueve a donde está el
  pasajero AHORA, y la ficha lo dice con palabras. Lo que sigue sin usarse es
  la posición en vivo para el ETA que ve el taxista y para el aviso de
  «llegando»; y si el pasajero se aleja mucho del punto donde pidió, nadie le
  avisa de que el taxi va a otro sitio.



- **[P46-02] El pasajero no puede corregir su punto de recogida.** Si el GPS lo
  sitúa mal, o si está esperando en otra esquina a propósito, no hay forma de
  mover el pin. Con el punto ya viniendo del GPS esto importa menos que antes,
  pero sigue siendo la salida cuando la máquina se equivoca.

- **[P46-03] Las solicitudes anteriores a la 046 no tienen precisión.**
  `precision_cliente_m` es NULL en todas ellas, así que su punto de recogida
  sigue siendo la referencia del catálogo aunque tengan coordenada guardada. Es
  deliberado —no se sabe si esa coordenada vale— y se corrige solo a medida que
  entran solicitudes nuevas.

- **[P43-01] Compartir el viaje cuesta un SMS por cada persona que mira.**
  Decisión del operador (migración 043): quien abre el enlace de «mírame
  llegar» tiene que verificar su propio número. Convierte un enlace suelto en
  una lista de personas con número —que el pasajero ve en su pantalla— pero
  tiene dos costes que hay que vigilar cuando esto se use de verdad: el dinero
  de los SMS, y el estorbo para alguien asustado a las once de la noche que
  solo quiere ver si su hija ha llegado. Si el segundo pesa demasiado, la
  alternativa es un enlace secreto sin verificar (como Uber), que ya se
  descartó a propósito.

- **[P43-02] El pasajero pierde el enlace si recarga la página.** El token se
  guarda hasheado, así que el servidor no puede devolverlo. Mientras la
  pantalla siga abierta se puede copiar; después solo queda cortarlo y
  compartir otro. Guardarlo en el propio teléfono lo arreglaría.

- **[P42-02] La tabla `rastro` es la que más crece de toda la base.** Un punto
  por taxi cada minuto de turno. Se filtra al escribir y se purga sola cada
  seis horas por `rastro_retencion_dias` (90), pero nadie ha medido todavía
  cuánto ocupa de verdad con la flota real. Si aprieta, lo primero que hay que
  tocar son los parámetros (`rastro_intervalo_min_seg`,
  `rastro_distancia_min_m`), que se cambian desde Ajustes sin desplegar.

- **[P41-01] Google Maps no puede ser la fuente del catálogo.** Se planteó
  coger de Google las ubicaciones que faltan. No se puede: sus términos
  prohíben guardar sus coordenadas para construir una base de datos propia y
  prohíben enseñar sus datos sobre un mapa que no sea el suyo, que es
  exactamente lo que son `zona` y `referencia`. Se puede usar su buscador en
  vivo, pagando por consulta y sin guardar nada, pero eso no fija nada: al día
  siguiente se está igual. Y aparte, Google conoce Malabo por encima: tiene los
  hoteles y las embajadas, no tiene Comandachina ni Barrio Bisinga. La fuente
  es OpenStreetMap (ODbL, cita obligatoria), que es de donde ya salió el
  catálogo actual — ver `scripts/importar-osm-bioko.ts`.

- **[P41-02] Los pueblos que OSM conoce y aquí no son zona.** El importador de
  Bioko los lista y no los da de alta a propósito: crear una zona cambia la
  topología del reparto (vecinas, oleadas), y quién es un barrio de verdad en
  Baney o Luba no lo decide un punto de OpenStreetMap. Queda como cola de
  trabajo para el operador, que los va confirmando.

## Resueltos

- **[P7-03] La valoración del pasajero, por fin pedida** — resuelto el
  2026-09-25. El enrutamiento siempre dijo «diferida a próxima sesión», y no se
  pedía en ninguna: quien se baja del taxi cierra la aplicación. Ahora, al
  abrir sin viaje en marcha, se pregunta por el último viaje completado sin
  valorar (dentro de `valoracion_pendiente_dias`), diciendo de qué viaje se
  habla. «Ahora no» se respeta para ese viaje y no se vuelve a insistir: una
  pregunta que reaparece se contesta al azar, y una nota al azar es peor que
  ninguna. Sin valoraciones no hay reputación (P14-04) ni forma de saber quién
  cobra de más (P12-02), así que esto era la base de las dos.

- **[P12-01] Las bandas de precio tienen fuente de datos otra vez** — resuelto
  el 2026-09-25 (migración 066). La 012 quitó el reporte de precio por una
  razón buena —fricción a cambio de nada, el dinero no pasa por aquí— y esa
  razón se respeta: el conductor no declara nada y el pasajero no teclea. En la
  pantalla de valoración se le ofrecen tres importes de un toque, sacados de la
  banda de SU ruta, y puede no tocar ninguno. Con
  `banda_muestras_minimas` respuestas o más, la banda se calcula sola de lo que
  la gente dice que paga; con menos se respeta la que escribió el operador,
  porque su criterio de campo vale más que tres cifras sueltas. `muestras` deja
  a la vista cuál es cuál. Nunca es una tarifa: el precio se negocia.

- **[P12-02] Vuelve a poder mirarse el abuso de tarifa** — resuelto el
  2026-09-25 (migración 066, regla R5). Dos señales, y la primera es la que
  vale: el pasajero puede marcar «me cobró de más», que no necesita ninguna
  cifra y por eso la usa cualquiera; y los viajes cuyo precio declarado queda
  por encima del p75 de su ruta. Un viaje así no dice nada —una noche, lluvia,
  maletas—; lo que dice algo es que sean casi todos. Sale como alarma en el
  cuadro de mandos del operador pasadas `alarma_cobros_de_mas` marcas en 30
  días, con los dos números delante: decide el operador, no la alarma.

- **[P25-01] Los cambios de precio dejan rastro** — resuelto el 2026-09-25
  (migración 067). Quién cambió una banda o un parámetro del sistema, cuándo, y
  qué había antes. La tabla es append-only con el mismo candado que
  `transicion` y `apunte`: un registro de auditoría que se puede editar no es
  un registro de auditoría. Se lee desde el panel («Quién tocó qué») y solo lo
  ve el operador: quién vigila a los agentes no es un agente. Se auditan
  también los parámetros, que cambian el comportamiento entero sin desplegar.

- **[P14-04] La reputación cuenta en el reparto** — resuelto el 2026-09-24
  (migración 065). Entra en el ORDEN de los candidatos, con tres cuidados:
  por TRAMOS y no por decimales (4,6 y 4,7 son el mismo taxista, y una décima
  no puede decidir quién come); solo con `reputacion_muestras_minimas`
  valoraciones o más —por debajo va en el tramo del medio, para que tres
  pasajeros de mal día no dejen a nadie sin trabajo y un taxista nuevo no
  arranque castigado—; y DESPUÉS de la prioridad que pone el operador a mano y
  de «va ya hacia allí», que es lo que le conviene al pasajero de esa carrera.
  Lo que no hace: excluir. El mal valorado recibe la carrera en la oleada
  siguiente, porque dejar a alguien sin trabajo por una media es una sanción y
  las sanciones las pone el operador con un nombre detrás. Dos pruebas.

- **[P42-01] Al taxista se le dice que su recorrido queda guardado** — resuelto
  el 2026-09-24. Una línea junto al botón de entrar en servicio, en la web y en
  la app de Android: en servicio se guarda por dónde pasa, fuera de servicio no
  se guarda nada, y se borra a los 90 días. Las tres cosas importan y la
  tercera es la que convierte «me vigilan» en «saben por dónde trabajé este
  mes». En Android va además en la notificación permanente, que ya lo decía.

- **[P58-01] El aviso a TODOS los taxistas** — resuelto el 2026-09-24
  (migración 064), y resuelto acotándolo: no se avisa a todos en cada
  petición, se avisa a todos **antes de rendirse**. La oleada 5 se dispara
  solo si se cumplen las dos cosas: han pasado 75 s desde la emisión (la
  expiración está en 90) y no hay NI UNA oferta viva. Si alguien la tiene
  delante sin contestar, no se convoca a nadie: su respuesta puede llegar, y
  quitarle la carrera al que está al lado del pasajero para dársela al que
  pulse antes desde la otra punta es justo lo que el reparto por oleadas
  evita. Cuando no la tiene nadie, un móvil sonando en Semu no le quita nada a
  nadie: es la carrera o nada. El corte de R1 pasa a mirar la ciudad entera
  por la misma razón —cerrar con «no hay taxi» a los cero segundos teniendo un
  taxi libre en otro barrio sería dar por perdido lo que esto viene a salvar—.
  Interruptor en `parametro.aviso_ciudad_entera`: a 0, el reparto es
  exactamente el de antes. Cuatro pruebas en `despacho.prueba.ts`, y las dos
  aplicaciones dicen «Nadie la ha cogido · puede estar lejos» en esa oferta,
  porque eso cambia la decisión del taxista. **Lo que cuesta, medido en el
  diseño y no en producción todavía:** el pasajero de una zona vacía espera
  hasta 75 s en vez de oír «no hay taxi» al momento, y durante esos últimos
  quince segundos los taxis convocados quedan OFERTADO —y un taxista solo
  puede tener una oferta delante (P8-03)—, así que otra petición que entre
  justo entonces se queda sin a quién ofrecérsela. Con la flota de hoy es raro
  y dura poco; con muchas peticiones a la vez habrá que revisarlo.

- **[P56-02] «Al volante» ya no supone a qué velocidad se va** — resuelto el
  2026-09-24 (migración 063). Con cada punto del recorrido se guarda la
  velocidad que MIDE el receptor (`coords.speed` en la PWA, `Location.speed`
  en Android, las dos en m/s y convertidas a km/h en el móvil), y el tiempo al
  volante se calcula con ella en vez de con la velocidad típica de cada clase
  de calle del enrutador. Medido en el mismo recorrido de 4,4 km por la
  carretera del aeropuerto: estimando salían 9 minutos de volante a 29,5 km/h;
  con la medida de un coche a 45, salen 5,9 minutos a 45,0. **Sigue siendo
  opcional en todo el camino:** un teléfono sin fijación buena no da velocidad,
  las versiones que ya están en la calle no la mandan y el recorrido viejo no
  la tiene — en todos esos casos se estima como antes. Dos defensas: una
  lectura imposible (NaN, negativa, 300 km/h) se guarda como «no se sabe» en
  vez de reventar el latido, y una medida de coche parado con metros de por
  medio no se usa, porque esas dos lecturas no describen el trayecto. Cinco
  pruebas en `rastro.prueba.ts`. **Lo que falta por saber:** cuánto cambia el
  informe con datos de verdad; hasta que un turno entero se grabe con la
  aplicación nueva no hay más que la medida de laboratorio de arriba.

- **[P62-02] Elegir coche no reserva nada, y ahora se dice** — resuelto el
  2026-09-24. Lo que NO cambia: elegir sigue siendo una preferencia y no una
  reserva; a un taxista no se le puede obligar a aceptar, así que pasada su
  exclusiva de veinte segundos la carrera sigue el reparto de siempre. Lo que
  cambia es que el pasajero se entera. `GET /api/solicitudes/:id` devuelve
  `elegido` con el coche que eligió y en qué quedó: `esperando` mientras corre
  su exclusiva, `no_la_cogio` en cuanto la carrera pasa de la oleada 0 o él
  contesta que no, y `es_el_tuyo` si la cogió. Se dice en la espera —todavía a
  tiempo de decidir si sigue esperando o cancela— y junto a la ficha del taxi
  que sí viene. Tres pruebas en `servidor.prueba.ts`. Sin coordenadas de por
  medio: matrícula, nombre y en qué quedó, nada más.

- **[P56-01] Recorrido el doble de denso, al mismo coste** — resuelto el
  2026-09-15 (migración 056), decidido por el operador. `rastro_intervalo_min_seg`
  pasa de 45 a 15 s y `rastro_retencion_dias` de 90 a 45. El mínimo va por
  DEBAJO del latido (20 s) a propósito: el latido no llega exacto, y con el
  mínimo igual al latido se tiraría uno de cada dos. Medido en seis
  simulaciones: un punto cada ~25 s, kilómetros −4 % (antes −9 %), velocidad en
  marcha −8 % (antes −19 %), tiempo al volante 0 % (antes +4 %). Coste, con los
  219 bytes por fila medidos en la base: un taxi de 8 h diarias pasa de ~9,8 MB
  a ~11,3 MB. Las dos colas sin red (PWA y Android) cambiadas igual. **Lo que
  no se deshace:** al desplegar, la purga borra el recorrido de más de 45 días.

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
