# Plataforma de intermediación de taxis — Malabo

Intermediación entre pasajeros y taxistas sin dinero por la plataforma:
el pasajero paga en efectivo al taxista y la plataforma cobra al taxista una
comisión fija por viaje validado, descontada de un monedero prepago.
La especificación completa vive en el documento de arranque de la sesión.

## Estructura

```
servidor/    Backend Node.js + TypeScript (Fastify) y base de datos
  migraciones/   SQL puro, pares NNN_nombre.up.sql / .down.sql
  src/bd/        Ejecutor de migraciones
  src/dominio/   Máquina de estados, monedero, gazetteer, despacho
  src/eventos/   Bus outbox + adaptadores (sse, fcm, noop)
  src/api/       API HTTP del cliente y arranque del servidor
  scripts/       BD de desarrollo, datos de prueba, gazetteer, simulador
pwa/         PWA del pasajero (React + Vite + Leaflet, ~105 KB gzip)
android/     App Android del conductor (Kotlin, sin AppCompat, solo FCM)
```

## App del conductor (Android)

Requisitos: JDK 17+, SDK de Android (platform 34) y Gradle 8.9. Para FCM hace
falta un proyecto Firebase: consola de Firebase → añadir app Android con el
paquete `gq.taxi.conductor` → descargar `google-services.json` a
`android/app/`. Sin ese fichero el APK compila, pero FCM no funciona.

```
cd android
gradle assembleDebug          # APK de desarrollo en app/build/outputs/apk/debug
gradle assembleRelease        # APK de reparto (requiere firma)
```

Firma para el reparto (APK directo ahora, Play Store después): genera un
almacén UNA vez y usa siempre la misma clave — cambiarla rompe las
actualizaciones de los conductores:

```
keytool -genkeypair -v -keystore taxi-conductor.jks -alias taxi -keyalg RSA -keysize 2048 -validity 9125
```

La app pide al arrancar la dirección del servidor y el teléfono del
conductor (dado de alta por el operador). En el emulador, el servidor local
es `http://10.0.2.2:8080`.

## Servidor y PWA

```
cd pwa
npm install
npm run construir     # genera pwa/dist (la sirve el servidor)
cd ../servidor
npm run servir        # API + PWA en http://localhost:8080
```

En desarrollo sin FCM, desvía los eventos de conductor al canal noop:
`UPDATE enrutamiento SET canal_1='noop' WHERE canal_1='fcm';`
(la app del conductor del paso 8 lo devolverá a fcm con credenciales reales).

Para simular al conductor mientras no existe la app Android:

```
npx tsx scripts/simular-conductor.ts "+240222100002" mantener "Malabo Centro"
npx tsx scripts/simular-conductor.ts "+240222100002" ofertas
npx tsx scripts/simular-conductor.ts "+240222100002" aceptar
npx tsx scripts/simular-conductor.ts "+240222100002" salir
npx tsx scripts/simular-conductor.ts "+240222100002" recoger
npx tsx scripts/simular-conductor.ts "+240222100002" completar
```

`mantener` deja el heartbeat vivo (como el foreground service de la app):
déjalo corriendo en su propia ventana mientras pruebas. Las demás órdenes
deducen solas la solicitud, sin copiar identificadores. Para simular el GPS
continuo cuando el navegador no está en Malabo:

```
npx tsx scripts/simular-conductor.ts "+240222100002" posicion 3.7523 8.7741
npx tsx scripts/simular-conductor.ts "+240222100002" posicion-cliente 3.7526 8.7743
```

## Desarrollo local (paso 1)

Requisitos: Node 24+. No hace falta Docker ni instalar PostgreSQL: el script
de desarrollo usa binarios embebidos de PostgreSQL 16.

Órdenes sueltas (válidas en PowerShell y en cualquier shell; en PowerShell 5.1
no existe `&&`, ejecútalas una a una):

```
cd servidor
npm install
npm run bd:dev        # arranca PostgreSQL 16 en localhost:5433 (dejar abierto)
npm run bd:migrar     # aplica las migraciones (en otra ventana)
npm run bd:semilla    # carga 3 zonas, 20 referencias y 5 conductores
```

Otras órdenes:

```
npm run bd:estado                        # migraciones aplicadas/pendientes
npm run bd:revertir                      # revierte la última
npm run bd:revertir -- todo              # revierte todas
npx tsx scripts/consulta.ts "SELECT 1"   # consulta ad hoc
npm run probar                           # batería de pruebas (requiere bd:dev + semilla)
npm run limpiar                          # cierra sobras de pruebas en la BD de desarrollo
```

## Mapa: plano real compilado dentro de la app

Las calles de Malabo vienen de OpenStreetMap pero **no se descargan en
ejecución**: se compilan a un fichero que viaja con la aplicación.

```
cd pwa
npm run compilar-mapa
```

Eso consulta Overpass, filtra y simplifica la geometría, y escribe
`src/mapa-malabo.json` (3.756 vías, 55 KB comprimidos). Se ejecuta a mano
cuando quieras refrescar el plano, no en cada compilación. Ventajas frente a
las baldosas: una sola descarga, funciona sin conexión, y ninguna dependencia
de la política de uso de los servidores de OSM.

La atribución a OpenStreetMap (datos ODbL) es obligatoria y está en la
interfaz: no debe quitarse.

## Ver pasajero y taxista a la vez

La identidad es el dispositivo y vive en `localStorage`, que se comparte entre
pestañas. Para tener las dos abiertas, **en localhost** se puede fijar con
`?dispositivo=`; fuera de localhost se ignora a propósito (el uuid es la
credencial, aceptarla por URL sería regalar la suplantación).

Prepara las dos cuentas:

```
npx tsx scripts/preparar-demo.ts
```

Y abre cada enlace en su propia ventana:

- Pasajera Ana: <http://localhost:8080/?dispositivo=11111111-1111-4111-8111-111111111111>
- Taxista Pablo: <http://localhost:8080/?dispositivo=22222222-2222-4222-8222-222222222222>

Una cinta amarilla arriba avisa de que la identidad viene forzada, para no
confundir una sesión de pruebas con una real. El taxista queda **en servicio**:
mientras su ventana esté abierta manda su latido y recibe carreras.

## Galería de diseños

Todas las pantallas de los dos roles, con datos de ejemplo, sin tener que
recorrer el flujo:

**http://localhost:8080/?galeria**

Usa las mismas vistas que la aplicación (`VistaCliente` y `VistaConductor`),
así que lo que se ve ahí es lo que se ve de verdad: si cambia el diseño, la
galería cambia con él. El plano de fondo es estático porque veintisiete mapas
de Leaflet a la vez no son sostenibles.

## Los dos roles

Al abrir por primera vez se elige rol: pasajero (teléfono y/o correo) o taxista
(nombre, teléfono, correo, matrícula, marca y carrocería turismo o 4x4). El
panel del taxista en la web sirve para probar el sistema completo en localhost;
los conductores reales usan la app Android de `android/`.

Quien se da de alta como taxista queda **pendiente de verificación** y no
recibe carreras hasta que se compruebe:

```
npx tsx scripts/verificar-conductor.ts pendientes
npx tsx scripts/verificar-conductor.ts verificar "+240222700700"
```

## Recargas del monedero

El taxista pide la recarga desde la app y elige Muni Dinero (555926804) o
efectivo. La app le da una **referencia** para el concepto del envío.

**El sistema no comprueba ningún pago.** El saldo sube solo cuando una persona
mira la cuenta de Muni Dinero (o recibe el efectivo) y confirma:

```
npx tsx scripts/recargas.ts pendientes
npx tsx scripts/recargas.ts confirmar "GUB-LGC" "pablo"
npx tsx scripts/recargas.ts rechazar "GUB-LGC" "pablo" "no llegó el ingreso"
```

El número de Muni Dinero y el importe mínimo están en la tabla `parametro`
(`muni_dinero_numero`, `recarga_minima_xaf`): se cambian sin desplegar.

## Gazetteer (catálogo de referencias)

El catálogo se mantiene sin desplegar con la herramienta de administración:

```
npm run gazetteer -- zonas
npm run gazetteer -- listar "Malabo Centro"
npm run gazetteer -- buscar "mercao semu"
npm run gazetteer -- crear-zona "Los Ángeles" 3.744 8.795
npm run gazetteer -- adyacencia "Los Ángeles" "Ela Nguema"
npm run gazetteer -- crear "Semu" "Farmacia Nueva" 3.7581 8.7660 "la farmacia nueva"
npm run gazetteer -- importar referencias.csv
npm run gazetteer -- exportar copia.csv
```

Formato CSV (separador «;», alias separados por «|», cabecera opcional):
`zona;nombre;lat;lng;alias1|alias2`. La zona debe existir previamente.

La conexión por defecto es `postgres://taxi:taxi@localhost:5433/taxi`;
se puede cambiar con la variable de entorno `BD_URL`.
