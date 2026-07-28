package gq.taxi.conductor

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.util.concurrent.Executors

// Pantalla única del conductor. El estado de verdad vive en el servidor:
// esta actividad lo pide (al abrir, al llegar un FCM y cada 15 s en primer
// plano) y pinta la sección que toque. Sin caché local del estado: la
// conectividad intermitente se lleva mejor siendo tonto y preguntando.
class ActividadPrincipal : Activity() {

    private val ejecutor = Executors.newSingleThreadExecutor()
    private val principal = Handler(Looper.getMainLooper())

    private var zonas: List<Pair<Long, String>> = emptyList()
    private var enServicio = false
    private var solicitudActiva: Long = -1

    private val receptorFcm = object : BroadcastReceiver() {
        override fun onReceive(contexto: Context?, intent: Intent?) {
            refrescar()
        }
    }

    private val sondeo = object : Runnable {
        override fun run() {
            refrescar()
            principal.postDelayed(this, 15_000)
        }
    }

    override fun onCreate(estado: Bundle?) {
        super.onCreate(estado)
        setContentView(R.layout.actividad_principal)

        val permisos = mutableListOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) {
            permisos.add(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissions(permisos.toTypedArray(), 1)

        vista<EditText>(R.id.campo_url).setText(Sesion.urlBase(this) ?: "http://10.0.2.2:8080")
        vista<EditText>(R.id.campo_telefono).setText(Sesion.telefono(this) ?: "+240")

        vista<Button>(R.id.boton_registrar).setOnClickListener { registrar() }
        vista<Button>(R.id.boton_servicio).setOnClickListener { alternarServicio() }
        vista<Button>(R.id.boton_aceptar).setOnClickListener { accionSolicitud { Api.aceptar(this, it) } }
        vista<Button>(R.id.boton_rechazar).setOnClickListener { accionSolicitud { Api.rechazar(this, it) } }
        // Los botones de cada pasajero se construyen en pintarPasajeros():
        // con taxi compartido hay hasta 4 bloques y cada uno va por su cuenta.
    }

    override fun onResume() {
        super.onResume()
        val filtro = IntentFilter(ServicioMensajes.ACCION_ACTUALIZAR)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receptorFcm, filtro, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receptorFcm, filtro)
        }
        if (Sesion.registrado(this)) {
            principal.post(sondeo)
        }
    }

    override fun onPause() {
        unregisterReceiver(receptorFcm)
        principal.removeCallbacks(sondeo)
        super.onPause()
    }

    // --- Acciones -----------------------------------------------------------

    private fun registrar() {
        val url = vista<EditText>(R.id.campo_url).text.toString().trim()
        val telefono = vista<EditText>(R.id.campo_telefono).text.toString().trim()
        if (url.isEmpty() || telefono.isEmpty()) {
            avisar("Rellena la dirección del servidor y tu teléfono.")
            return
        }
        Sesion.guardarRegistro(this, url, telefono)
        ejecutor.execute {
            try {
                // El token FCM puede tardar o fallar sin google-services.json:
                // el registro no se bloquea por él; onNewToken lo reenviará.
                val token = try {
                    com.google.android.gms.tasks.Tasks.await(FirebaseMessaging.getInstance().token)
                } catch (_: Exception) {
                    null
                }
                val respuesta = Api.registrar(this, telefono, token)
                principal.post {
                    avisar("")
                    aplicarRegistro(respuesta)
                    principal.removeCallbacks(sondeo)
                    principal.post(sondeo)
                }
            } catch (error: Exception) {
                principal.post { avisar(error.message ?: "No se pudo registrar.") }
            }
        }
    }

    private fun alternarServicio() {
        val posicion = vista<Spinner>(R.id.selector_zona).selectedItemPosition
        if (!enServicio && (posicion < 0 || posicion >= zonas.size)) {
            avisar("Elige tu zona antes de entrar en servicio.")
            return
        }
        val zonaId = if (zonas.isEmpty()) -1L else zonas[posicion.coerceIn(zonas.indices)].first
        val objetivo = !enServicio
        ejecutor.execute {
            try {
                Api.servicio(this, objetivo, zonaId)
                if (objetivo) {
                    Sesion.guardarZona(this, zonaId)
                    val intento = Intent(this, ServicioEnServicio::class.java)
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(intento) else startService(intento)
                } else {
                    stopService(Intent(this, ServicioEnServicio::class.java))
                }
                principal.post { refrescar() }
            } catch (error: Exception) {
                principal.post { avisar(error.message ?: "No se pudo cambiar el servicio.") }
            }
        }
    }

    // Acción sobre la solicitud «en foco» (la oferta pendiente). Los botones
    // de cada pasajero usan accionSobre con su propio identificador.
    private fun accionSolicitud(accion: (Long) -> JSONObject) {
        val solicitud = solicitudActiva
        if (solicitud <= 0) {
            avisar("No hay carrera activa.")
            return
        }
        accionSobre(solicitud, accion)
    }

    private fun accionSobre(solicitudId: Long, accion: (Long) -> JSONObject) {
        ejecutor.execute {
            try {
                accion(solicitudId)
                principal.post {
                    avisar("")
                    refrescar()
                }
            } catch (error: Exception) {
                // Errores con mensaje útil: «expiró hace N segundos», «PIN
                // incorrecto», «quedan N segundos»… se muestran tal cual.
                principal.post {
                    avisar(error.message ?: "No se pudo.")
                    refrescar()
                }
            }
        }
    }

    // --- Pintado ------------------------------------------------------------

    private fun refrescar() {
        if (!Sesion.registrado(this)) return
        ejecutor.execute {
            try {
                val estado = Api.estado(this)
                principal.post { pintar(estado) }
            } catch (_: Exception) {
                // Sin red: se reintenta en el siguiente sondeo. La pantalla
                // conserva lo último pintado.
            }
        }
    }

    private fun aplicarRegistro(respuesta: JSONObject) {
        vista<View>(R.id.seccion_registro).visibility = View.GONE
        vista<View>(R.id.seccion_principal).visibility = View.VISIBLE
        vista<TextView>(R.id.texto_nombre).text = respuesta.optString("nombre")

        val listaZonas = respuesta.optJSONArray("zonas") ?: return
        zonas = (0 until listaZonas.length()).map {
            val zona = listaZonas.getJSONObject(it)
            zona.getLong("id") to zona.getString("nombre")
        }
        val selector = vista<Spinner>(R.id.selector_zona)
        selector.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, zonas.map { it.second },
        )
        val guardada = zonas.indexOfFirst { it.first == Sesion.zonaId(this) }
        if (guardada >= 0) selector.setSelection(guardada)
    }

    private fun pintar(estado: JSONObject) {
        vista<View>(R.id.seccion_registro).visibility = View.GONE
        vista<View>(R.id.seccion_principal).visibility = View.VISIBLE

        enServicio = estado.optString("estado") != "DESCONECTADO"
        vista<TextView>(R.id.texto_saldo).text = "Saldo: ${estado.optLong("saldoXaf")} XAF"
        vista<TextView>(R.id.texto_estado).text =
            "Estado: ${estado.optString("estado")}${estado.optString("zona").let { if (it.isEmpty() || it == "null") "" else " · $it" }}"
        vista<Button>(R.id.boton_servicio).text =
            getString(if (enServicio) R.string.accion_salir_servicio else R.string.accion_entrar_servicio)
        vista<Spinner>(R.id.selector_zona).visibility = if (enServicio) View.GONE else View.VISIBLE

        // Oferta pendiente (la primera): origen, destino y banda de precio.
        val ofertas = estado.optJSONArray("ofertas")
        val oferta = if (ofertas != null && ofertas.length() > 0) ofertas.getJSONObject(0) else null
        vista<View>(R.id.seccion_oferta).visibility = if (oferta != null) View.VISIBLE else View.GONE
        if (oferta != null) {
            solicitudActiva = oferta.getLong("solicitudId")
            vista<TextView>(R.id.texto_oferta).text =
                "${oferta.optString("origen")} → ${oferta.optString("destino")}"
            val banda = oferta.optJSONObject("bandaPrecio")
            vista<TextView>(R.id.texto_oferta_banda).text =
                if (banda == null) "Sin precio orientativo de esta ruta todavía"
                else "Se suele pagar ${banda.optLong("p25")}–${banda.optLong("p75")} XAF"
        }

        // Taxi compartido: un bloque de botones por pasajero.
        pintarPasajeros(estado)
        val cuantosPasajeros = estado.optJSONArray("pasajeros")?.length() ?: 0
        if (oferta == null && cuantosPasajeros == 0) {
            solicitudActiva = -1
        }
    }

    // Reconstruye la lista de pasajeros en cada refresco. Son 4 como máximo:
    // recrear las vistas es más simple y barato que sincronizarlas, y evita
    // arrastrar RecyclerView (y su peso) al APK.
    private fun pintarPasajeros(estado: JSONObject) {
        val contenedor = vista<LinearLayout>(R.id.contenedor_pasajeros)
        contenedor.removeAllViews()

        val pasajeros = estado.optJSONArray("pasajeros")
        val cuantos = pasajeros?.length() ?: 0
        val textoOcupacion = vista<TextView>(R.id.texto_ocupacion)
        if (cuantos == 0) {
            textoOcupacion.visibility = View.GONE
            return
        }
        textoOcupacion.visibility = View.VISIBLE
        textoOcupacion.text = getString(
            R.string.ocupacion,
            estado.optInt("plazas") - estado.optInt("plazasLibres"),
            estado.optInt("plazas"),
        )

        for (indice in 0 until cuantos) {
            val pasajero = pasajeros!!.getJSONObject(indice)
            contenedor.addView(bloquePasajero(pasajero, indice + 1))
        }
    }

    private fun bloquePasajero(pasajero: JSONObject, numero: Int): View {
        val solicitudId = pasajero.getLong("solicitudId")
        val estadoViaje = pasajero.optString("estado")
        val llegado = pasajero.optString("llegadoEn").let { it.isNotEmpty() && it != "null" }

        val bloque = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 24, 0, 24)
        }

        bloque.addView(TextView(this).apply {
            text = "$numero. ${pasajero.optString("origen")} → ${pasajero.optString("destino")}\n$estadoViaje"
            textSize = 18f
        })

        val telefono = pasajero.optString("telefonoCliente")
        if (telefono.isNotEmpty() && telefono != "null") {
            // Protocolo de encuentro R4: la llamada es el mecanismo principal.
            bloque.addView(boton(getString(R.string.accion_llamar)) {
                startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$telefono")))
            })
        }

        if (estadoViaje == "ACEPTADO") {
            bloque.addView(boton(getString(R.string.accion_salir)) {
                accionSobre(solicitudId) { Api.salir(this, it) }
            })
        }

        if (estadoViaje == "EN_CAMINO") {
            if (!llegado) {
                bloque.addView(boton(getString(R.string.accion_llegado)) {
                    val posicion = Ubicacion.actual(this)
                    accionSobre(solicitudId) {
                        Api.heLlegado(this, it, posicion?.latitude, posicion?.longitude)
                    }
                })
            } else {
                bloque.addView(TextView(this).apply {
                    text = "Esperando (${pasajero.optInt("relojEsperaSeg") / 60} min). El pasajero lo ve igual que tú."
                    textSize = 15f
                })
                bloque.addView(boton(getString(R.string.accion_ausente)) {
                    accionSobre(solicitudId) { Api.clienteAusente(this, it) }
                })
            }
            // Confirmación manual: respaldo de la recogida automática por GPS.
            bloque.addView(boton(getString(R.string.accion_recoger)) {
                val posicion = Ubicacion.actual(this)
                accionSobre(solicitudId) {
                    Api.recoger(this, it, null, posicion?.latitude, posicion?.longitude)
                }
            })
        }

        if (estadoViaje == "RECOGIDO") {
            bloque.addView(boton(getString(R.string.accion_completar)) {
                accionSobre(solicitudId) { Api.completar(this, it) }
            })
        }
        return bloque
    }

    private fun boton(etiqueta: String, alPulsar: () -> Unit): Button =
        Button(this).apply {
            text = etiqueta
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (56 * resources.displayMetrics.density).toInt(),
            )
            setOnClickListener { alPulsar() }
        }

    private fun avisar(mensaje: String) {
        val texto = vista<TextView>(R.id.texto_aviso)
        texto.text = mensaje
        texto.visibility = if (mensaje.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun <T : View> vista(id: Int): T = findViewById(id)
}
