# El puente de las llamadas (TURN)

Las llamadas entre pasajero y taxista van directas de un teléfono al otro. Este
servidor solo hace falta cuando no pueden verse, que en datos móviles es
bastante a menudo.

## Por qué hace falta

Casi todos los operadores móviles ponen a sus clientes detrás de un **NAT
compartido**: cientos de teléfonos salen a internet con la misma dirección
pública. Dos teléfonos así no pueden abrir una conexión directa entre ellos,
porque ninguno tiene una dirección a la que el otro pueda llamar.

STUN resuelve el caso fácil: cada teléfono descubre cómo se le ve desde fuera y
se lo dice al otro. Cuando eso no basta, hace falta un **TURN**: una máquina con
IP pública por la que pasa el audio, y que por tanto paga el tráfico.

En redes móviles africanas la proporción de llamadas que acaban necesitando TURN
es alta. **Sin este servidor, una parte de las llamadas simplemente no
conectará** — la aplicación lo dice con todas las letras («No se pudo conectar»)
en vez de dejar el «llamando…» eterno, pero no conectará.

## Qué hace falta

| | |
|---|---|
| Máquina | La más pequeña sirve; lo que se agota es el ancho de banda, no la CPU |
| IP | Pública y fija |
| Puertos | 3478 UDP y TCP, 5349 TCP (TLS), 49152–65535 UDP |
| Dónde | Europa occidental da mejor latencia a Guinea Ecuatorial que Norteamérica |

**Cuentas del tráfico.** Cada llamada relevada consume ~20 kbps en cada
dirección, o sea unos **300 KB por minuto** de tráfico en el servidor (entra y
sale). Con 1 TB de transferencia al mes:

- ≈ **3,4 millones de minutos** de llamada relevada al mes
- o unos 110.000 minutos al día

Y eso solo para las llamadas que *necesitan* puente; las que conectan directas
no le cuestan nada. Un TB al mes viene incluido en casi cualquier servidor
pequeño, así que el coste real de esto es el alquiler de la máquina, no el
tráfico.

## Puesta en marcha

```bash
sudo apt install coturn
```

Genera el secreto compartido:

```bash
openssl rand -hex 32
```

Copia la configuración y cambia las tres líneas marcadas `CAMBIAR`
(`external-ip`, `realm`/`server-name` y `static-auth-secret`):

```bash
sudo cp turnserver.conf /etc/turnserver.conf
```

Arranca:

```bash
sudo systemctl enable --now coturn
```

Y en el servidor de la aplicación, las variables de entorno:

```bash
TURN_URL=turn:turn.taximalabo.gq:3478
TURN_SECRETO=el-mismo-secreto-que-en-turnserver.conf
```

El `TURN_SECRETO` **tiene que ser idéntico** al `static-auth-secret`. Es lo
único que une las dos máquinas: la aplicación firma con él credenciales que
caducan a los 15 minutos, y coturn las verifica sin necesitar una base de datos
de usuarios.

## Cómo comprobar que funciona

La página de pruebas de WebRTC de Google
(`https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`)
acepta una URL de TURN con usuario y clave y dice si obtiene candidatos de tipo
`relay`. Para sacar unas credenciales válidas, pide la configuración desde un
viaje en curso:

```bash
curl -s "http://TU_SERVIDOR/api/solicitudes/<id>/llamada/configuracion" \
  -H "x-dispositivo: <uuid del pasajero de ese viaje>"
```

Si no hay candidatos `relay`, casi siempre es el cortafuegos: el rango
49152–65535 UDP tiene que estar abierto, y es lo que más se olvida.

## Lo que este servidor NO ve

WebRTC cifra el audio de extremo a extremo (DTLS-SRTP). El puente reenvía
paquetes que no puede descifrar, así que **ni el operador del TURN puede
escuchar las llamadas**. Aun así conviene que la máquina sea tuya: quien opera
el puente sí ve *que* dos direcciones IP hablaron y cuánto rato.

Por eso las credenciales llevan un identificador aleatorio en vez del
dispositivo o el viaje: el log de coturn registra el nombre de usuario, y no hay
motivo para que ese log pueda reconstruir quién viajó con quién.

## Alternativa sin montar nada

Servicios como Twilio, Metered o Cloudflare Calls venden TURN por minuto o por
gigabyte. Sale más caro por unidad y mete a un tercero en medio (que vería los
metadatos: qué IPs hablan y cuándo), pero evita mantener una máquina. Para un
piloto puede tener sentido; para producción, un coturn propio es más barato y
más privado.
