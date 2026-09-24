package gq.taxi.conductor

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.Date

// Las acciones del viaje que se pulsaron sin cobertura (migración 057).
//
// La PWA ya lo hacía y esta app no: aquí «pasajero recogido» sin red daba un
// error y no se guardaba en ningún sitio. El viaje se quedaba abierto y la
// hora, perdida — y es peor que en la PWA, porque esta app existe justamente
// para trabajar donde el navegador no llega: el móvil bloqueado, el barrio sin
// cobertura, la subida a Basilé.
//
// Cada acción se guarda con LA HORA EN QUE SE PULSÓ y sale en cuanto hay red,
// en el mismo orden. El servidor acepta esa hora (`ocurridoEn`) y trata cada
// acción como repetible desde la 057, así que reenviar lo que ya llegó no
// rompe nada.
//
// LO QUE NO PASA POR AQUÍ, a propósito: aceptar y rechazar una carrera. Valen
// AHORA; aceptadas veinte minutos tarde le quitarían la carrera a otro taxista
// que ya la hizo. Sin red se dice que hace falta red y punto.
//
// Mismo formato que ColaRastro —un fichero de texto, una línea de JSON por
// acción— y por lo mismo: añadir al final es la operación más barata que hay,
// y aquí no se acumulan miles de líneas sino unas pocas.
object ColaAcciones {

    private const val FICHERO = "acciones.jsonl"

    // Tope de seguridad. Cincuenta acciones son muchas más de las que caben en
    // un apagón de cobertura real (un viaje entero son cuatro), así que si se
    // llega a esto es que algo va mal; se dejan de aceptar nuevas antes que
    // tirar las viejas, porque una acción vieja sin mandar es un viaje abierto
    // en el servidor y la nueva probablemente se refiera a ese mismo viaje.
    private const val TOPE = 50

    private fun fichero(contexto: Context) = File(contexto.filesDir, FICHERO)

    // Guarda una acción para mandarla cuando haya red. Devuelve si pudo.
    @Synchronized
    fun encolar(
        contexto: Context,
        ruta: String,
        cuerpo: JSONObject,
        descripcion: String,
    ): Boolean {
        return try {
            if (cuantas(contexto) >= TOPE) return false
            val linea = JSONObject()
                .put("ruta", ruta)
                .put("cuerpo", cuerpo)
                // La hora del clic, en el mismo formato que el rastro.
                .put("pulsadaEn", ColaRastro.ISO.format(Date()))
                .put("descripcion", descripcion)
                .toString()
            fichero(contexto).appendText(linea + "\n")
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun cuantas(contexto: Context): Int {
        val f = fichero(contexto)
        if (!f.exists()) return 0
        return try {
            f.readLines().count { it.isNotBlank() }
        } catch (_: Exception) {
            0
        }
    }

    class Pendiente(val ruta: String, val cuerpo: JSONObject, val descripcion: String)

    // Todas las pendientes, EN ORDEN. Son pocas: no hace falta trocear.
    @Synchronized
    fun pendientes(contexto: Context): List<Pendiente> {
        val f = fichero(contexto)
        if (!f.exists()) return emptyList()
        return try {
            f.readLines().filter { it.isNotBlank() }.mapNotNull { linea ->
                try {
                    val json = JSONObject(linea)
                    val cuerpo = json.optJSONObject("cuerpo") ?: JSONObject()
                    // La hora del clic viaja dentro del cuerpo: es lo que el
                    // servidor entiende (migración 057).
                    cuerpo.put("ocurridoEn", json.getString("pulsadaEn"))
                    Pendiente(
                        json.getString("ruta"),
                        cuerpo,
                        json.optString("descripcion"),
                    )
                } catch (_: Exception) {
                    // Una línea a medias —el proceso murió escribiendo— se
                    // ignora: no puede atascar el resto de la cola.
                    null
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    // Borra las `cuantas` primeras. Solo cuando el servidor las ha aceptado, o
    // cuando las ha rechazado de forma definitiva (un 4xx: reintentarlas para
    // siempre no las haría válidas).
    @Synchronized
    fun olvidar(contexto: Context, cuantas: Int) {
        if (cuantas <= 0) return
        val f = fichero(contexto)
        if (!f.exists()) return
        try {
            val quedan = f.readLines().filter { it.isNotBlank() }.drop(cuantas)
            if (quedan.isEmpty()) f.delete() else f.writeText(quedan.joinToString("\n", postfix = "\n"))
        } catch (_: Exception) {
            // Si no se puede borrar se reenviará, y el servidor la dará por
            // hecha. Molesto, no grave.
        }
    }

    // Manda lo pendiente, EN ORDEN, y borra lo que sale. Devuelve cuántas
    // quedan sin mandar.
    //
    // Tres salidas por acción, las mismas que en la PWA:
    //   - Llega bien: se borra.
    //   - El servidor la rechaza con un 4xx: ya no tiene arreglo (el pasajero
    //     canceló mientras tanto). Se borra: reintentarla para siempre no la
    //     haría válida, y dejaría atascadas a las de detrás.
    //   - No llega, o el servidor falla (5xx): SE PARA AHÍ. No se salta a la
    //     siguiente, porque la siguiente puede ser «viaje terminado» y esta
    //     «pasajero recogido»: mandarlas desordenadas sería contar un viaje
    //     que termina antes de empezar.
    fun vaciar(contexto: Context): Int {
        val pendientes = pendientes(contexto)
        if (pendientes.isEmpty()) return 0
        var enviadas = 0
        for (accion in pendientes) {
            try {
                Api.enviarPendiente(contexto, accion.ruta, accion.cuerpo)
                enviadas += 1
            } catch (error: Api.ErrorApi) {
                if (error.codigo in 400..499) {
                    // Rechazo definitivo: se descarta y se sigue con la
                    // siguiente, que puede ser de otro viaje.
                    enviadas += 1
                    continue
                }
                break
            } catch (_: Exception) {
                // Sin red otra vez.
                break
            }
        }
        olvidar(contexto, enviadas)
        return pendientes.size - enviadas
    }
}
