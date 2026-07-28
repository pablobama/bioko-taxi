package gq.taxi.conductor

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

// Cliente HTTP mínimo: HttpURLConnection y org.json, sin dependencias.
// Payloads pequeños y timeouts cortos: la red es cara y va y viene.
//
// Todas las llamadas son SÍNCRONAS: se invocan siempre desde el executor de
// la actividad o del servicio, nunca desde el hilo principal.
object Api {

    class ErrorApi(val codigo: Int, mensaje: String) : Exception(mensaje)

    private fun peticion(
        contexto: Context,
        metodo: String,
        ruta: String,
        cuerpo: JSONObject?,
    ): JSONObject {
        val base = Sesion.urlBase(contexto)
            ?: throw ErrorApi(0, "Servidor sin configurar: haz el registro primero.")
        val conexion = URL(base + ruta).openConnection() as HttpURLConnection
        conexion.requestMethod = metodo
        conexion.connectTimeout = 10_000
        conexion.readTimeout = 15_000
        conexion.setRequestProperty("x-dispositivo", Sesion.uuidDispositivo(contexto))
        if (cuerpo != null) {
            conexion.setRequestProperty("content-type", "application/json")
            conexion.doOutput = true
            conexion.outputStream.use { it.write(cuerpo.toString().toByteArray()) }
        }
        try {
            val codigo = conexion.responseCode
            val flujo = if (codigo < 400) conexion.inputStream else conexion.errorStream
            val texto = flujo?.bufferedReader()?.use(BufferedReader::readText) ?: "{}"
            val json = if (texto.isBlank()) JSONObject() else JSONObject(texto)
            if (codigo >= 400) {
                throw ErrorApi(codigo, json.optString("error", "Error $codigo del servidor"))
            }
            return json
        } finally {
            conexion.disconnect()
        }
    }

    fun registrar(contexto: Context, telefono: String, tokenFcm: String?): JSONObject {
        val cuerpo = JSONObject().put("telefono", telefono)
        if (tokenFcm != null) cuerpo.put("fcmToken", tokenFcm)
        return peticion(contexto, "POST", "/api/conductor/registro", cuerpo)
    }

    fun servicio(contexto: Context, enServicio: Boolean, zonaId: Long): JSONObject =
        peticion(
            contexto, "POST", "/api/conductor/servicio",
            JSONObject().put("enServicio", enServicio).put("zonaId", zonaId),
        )

    // El heartbeat lleva la posición: el servidor solo la guarda si hay viaje
    // activo (GPS continuo durante el viaje, nunca fuera de él).
    fun heartbeat(contexto: Context, lat: Double?, lng: Double?): JSONObject {
        val cuerpo = JSONObject()
        val zonaId = Sesion.zonaId(contexto)
        if (zonaId > 0) cuerpo.put("zonaId", zonaId)
        if (lat != null && lng != null) cuerpo.put("lat", lat).put("lng", lng)
        return peticion(contexto, "POST", "/api/conductor/heartbeat", cuerpo)
    }

    fun estado(contexto: Context): JSONObject =
        peticion(contexto, "GET", "/api/conductor/estado", null)

    fun aceptar(contexto: Context, solicitudId: Long): JSONObject =
        peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/aceptar", JSONObject())

    fun rechazar(contexto: Context, solicitudId: Long): JSONObject =
        peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/rechazar", JSONObject())

    fun salir(contexto: Context, solicitudId: Long): JSONObject =
        peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/salir", JSONObject())

    fun heLlegado(contexto: Context, solicitudId: Long, lat: Double?, lng: Double?): JSONObject {
        val cuerpo = JSONObject()
        if (lat != null && lng != null) cuerpo.put("lat", lat).put("lng", lng)
        return peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/he-llegado", cuerpo)
    }

    fun clienteAusente(contexto: Context, solicitudId: Long): JSONObject =
        peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/cliente-ausente", JSONObject())

    // Confirmación manual de recogida. El PIN es opcional (si el operador
    // pide usarlo en algún caso, el servidor lo exige coincidir).
    fun recoger(contexto: Context, solicitudId: Long, pin: String?, lat: Double?, lng: Double?): JSONObject {
        val cuerpo = JSONObject()
        if (pin != null) cuerpo.put("pin", pin)
        if (lat != null && lng != null) cuerpo.put("lat", lat).put("lng", lng)
        return peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/recoger", cuerpo)
    }

    // Cierre sin precio: la plataforma no registra cuánto se pagó.
    fun completar(contexto: Context, solicitudId: Long): JSONObject =
        peticion(contexto, "POST", "/api/conductor/solicitudes/$solicitudId/completar", JSONObject())
}
