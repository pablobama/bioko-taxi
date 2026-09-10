package gq.taxi.conductor

import android.content.Context
import android.location.Location
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// El recorrido del turno, apuntado en el propio móvil (migración 051).
//
// El recorrido era un efecto secundario del latido: sin red no había latido, y
// sin latido ese trozo del turno no existía. En Malabo eso no es raro —un
// barrio sin cobertura, la subida a Basilé, los datos agotados a mitad de mes—
// y el taxista veía su propio recorrido con agujeros de media tarde.
//
// Aquí se apunta pase lo que pase con la red, y se sube cuando vuelve. Cada
// punto lleva SU hora, no la de llegada al servidor, así que el resultado no
// depende de si había cobertura.
//
// Un fichero de texto, una línea de JSON por punto. Ni base de datos ni
// dependencias: se escribe añadiendo al final, que es la operación más barata
// que existe, y se lee entero solo al subir. Con el tope de abajo el fichero no
// pasa de unos cientos de kilobytes.
object ColaRastro {

    private const val FICHERO = "rastro.jsonl"

    // Las mismas tres cifras que el servidor (`rastro_intervalo_min_seg`,
    // `rastro_distancia_min_m`, `rastro_anclaje_seg`) y que la PWA. Repetidas
    // porque este lado tiene que decidir SIN RED, que es justo cuando no puede
    // preguntarlas. Si algún día cambian allí, el servidor sigue mandando:
    // aclara otra vez al recibir el lote.
    private const val INTERVALO_MIN_MS = 45_000L
    private const val DISTANCIA_MIN_M = 40f
    private const val ANCLAJE_MS = 300_000L

    // A un punto cada 45 s son unas 75 horas de turno guardadas sin red: más
    // que cualquier apagón de cobertura real. Pasado el tope se tiran los MÁS
    // VIEJOS; si se tiraran los nuevos, un móvil que llenó la cola una vez no
    // volvería a apuntar nada nunca.
    private const val TOPE = 6000

    // Cuántos se mandan de una vez. Un lote entero por una red de Malabo es lo
    // que hace que se caiga la petición y no suba nada.
    const val LOTE = 100

    private val ISO = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }

    private var ultimo: Location? = null

    private fun fichero(contexto: Context) = File(contexto.filesDir, FICHERO)

    // Apunta un punto, o no. Devuelve si lo apuntó.
    //
    // Las cuatro reglas son las del servidor: el primero siempre; nada antes
    // del intervalo mínimo; si se movió lo bastante, sí; y si no se movió pero
    // hace rato del último, también — que es la diferencia entre «estuvo una
    // hora parado en la parada del mercado» y «no se sabe».
    @Synchronized
    fun anotar(contexto: Context, posicion: Location): Boolean {
        val previo = ultimo
        if (previo != null) {
            val transcurrido = posicion.time - previo.time
            if (transcurrido < INTERVALO_MIN_MS) return false
            if (previo.distanceTo(posicion) < DISTANCIA_MIN_M && transcurrido < ANCLAJE_MS) {
                return false
            }
        }
        val linea = JSONObject()
            .put("lat", posicion.latitude)
            .put("lng", posicion.longitude)
            .put("en", ISO.format(Date(posicion.time)))
            .toString()
        return try {
            fichero(contexto).appendText(linea + "\n")
            ultimo = posicion
            recortar(contexto)
            true
        } catch (_: Exception) {
            // Sin sitio en disco o sin permiso: se pierde el recorrido, pero el
            // turno del taxista no se interrumpe por eso.
            false
        }
    }

    private fun recortar(contexto: Context) {
        val f = fichero(contexto)
        val lineas = f.readLines()
        if (lineas.size <= TOPE) return
        f.writeText(lineas.takeLast(TOPE).joinToString("\n", postfix = "\n"))
    }

    // Los primeros `LOTE` puntos pendientes, ya como JSON listo para mandar.
    @Synchronized
    fun pendientes(contexto: Context): List<JSONObject> {
        val f = fichero(contexto)
        if (!f.exists()) return emptyList()
        return try {
            f.readLines()
                .asSequence()
                .filter { it.isNotBlank() }
                .take(LOTE)
                .mapNotNull { linea ->
                    try {
                        JSONObject(linea)
                    } catch (_: Exception) {
                        // Una línea a medias —el proceso murió escribiendo— se
                        // ignora. Un punto perdido no vale una cola atascada.
                        null
                    }
                }
                .toList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    // Borra los `cuantos` primeros. Se llama SOLO cuando el servidor confirma
    // haberlos recibido; si la respuesta se pierde, el lote se reenvía y allí
    // se descarta por repetido, que para eso está el índice único de la 051.
    @Synchronized
    fun olvidar(contexto: Context, cuantos: Int) {
        if (cuantos <= 0) return
        val f = fichero(contexto)
        if (!f.exists()) return
        try {
            val quedan = f.readLines().filter { it.isNotBlank() }.drop(cuantos)
            if (quedan.isEmpty()) f.delete()
            else f.writeText(quedan.joinToString("\n", postfix = "\n"))
        } catch (_: Exception) {
            // Si no se puede borrar, se reenviará y el servidor lo descartará.
            // Molesto, no grave.
        }
    }

    // Al entrar en servicio: el primer punto del turno siempre se guarda, no
    // se compara con el último de ayer.
    @Synchronized
    fun olvidarUltimo() {
        ultimo = null
    }
}
