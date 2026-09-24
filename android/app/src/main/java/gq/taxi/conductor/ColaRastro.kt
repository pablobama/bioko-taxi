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
    // 15 s desde la migración 056 (antes 45): con el recorrido reconstruido por
    // calles, un punto cada ~25 s tiene la mitad de error que uno por minuto.
    private const val INTERVALO_MIN_MS = 15_000L
    private const val DISTANCIA_MIN_M = 40f
    private const val ANCLAJE_MS = 300_000L
    // Y `rastro_precision_maxima_m` (migración 054). Importa aquí más que en
    // ningún otro sitio: esta app pide posiciones también al proveedor de RED,
    // para que el latido tenga algo dentro de un edificio, y esas lecturas
    // vienen con cientos de metros de error. Sirven para decir «está por esta
    // zona»; en el recorrido dibujan líneas que no existieron y suman
    // kilómetros inventados.
    private const val PRECISION_MAXIMA_M = 50f

    // A un punto cada 15 s son unas 50 horas de turno guardadas sin red: más
    // que cualquier apagón de cobertura real. Pasado el tope se tiran los MÁS
    // VIEJOS; si se tiraran los nuevos, un móvil que llenó la cola una vez no
    // volvería a apuntar nada nunca.
    private const val TOPE = 12_000

    // Cuántos se mandan de una vez. Un lote entero por una red de Malabo es lo
    // que hace que se caiga la petición y no suba nada.
    const val LOTE = 100

    // Público: el latido manda la hora de la lectura con el mismo formato.
    val ISO = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }

    private var ultimo: Location? = null
    private var anotadosDesdeRecorte = 0

    private fun fichero(contexto: Context) = File(contexto.filesDir, FICHERO)

    // Apunta un punto, o no. Devuelve si lo apuntó.
    //
    // Las cuatro reglas son las del servidor: el primero siempre; nada antes
    // del intervalo mínimo; si se movió lo bastante, sí; y si no se movió pero
    // hace rato del último, también — que es la diferencia entre «estuvo una
    // hora parado en la parada del mercado» y «no se sabe».
    // Metros por segundo a km/h, que es como viaja y como se guarda. Una
    // lectura rota —NaN, infinito, negativa o de avión— se deja fuera: vale
    // menos que no decir nada, porque el servidor la creería.
    fun velocidadKmh(metrosPorSegundo: Float): Double? {
        if (metrosPorSegundo.isNaN() || metrosPorSegundo.isInfinite()) return null
        val kmh = metrosPorSegundo * 3.6
        if (kmh < 0 || kmh > 300) return null
        return Math.round(kmh * 10.0) / 10.0
    }

    @Synchronized
    fun anotar(contexto: Context, posicion: Location): Boolean {
        // La lectura mala fuera, y ANTES del aclarado: si contara, ocuparía el
        // hueco de 15 s y se perdería la buena de GPS que llega justo detrás.
        // Sin precisión conocida se acepta, como en el servidor.
        if (posicion.hasAccuracy() && posicion.accuracy > PRECISION_MAXIMA_M) return false
        val previo = ultimo
        if (previo != null) {
            val transcurrido = posicion.time - previo.time
            if (transcurrido < INTERVALO_MIN_MS) return false
            if (previo.distanceTo(posicion) < DISTANCIA_MIN_M && transcurrido < ANCLAJE_MS) {
                return false
            }
        }
        val json = JSONObject()
            .put("lat", posicion.latitude)
            .put("lng", posicion.longitude)
            .put("en", ISO.format(Date(posicion.time)))
        if (posicion.hasAccuracy()) json.put("precision", posicion.accuracy.toDouble())
        // La velocidad que MIDE el receptor, en km/h (migración 063). Android
        // la da en metros por segundo y `hasSpeed()` dice si la sabe: sin ella
        // el servidor tiene que deducir el tiempo al volante de restar dos
        // posiciones, y entre dos lecturas separadas un minuto no hay forma de
        // saber cuánto fue semáforo.
        if (posicion.hasSpeed()) json.put("velocidad", velocidadKmh(posicion.speed))
        val linea = json.toString()
        return try {
            fichero(contexto).appendText(linea + "\n")
            ultimo = posicion
            // Cada cien puntos, no en cada uno: recortar lee el fichero entero,
            // y con un punto cada 15 s eso era leer un megabyte cuatro veces por
            // minuto para, casi siempre, no cortar nada.
            anotadosDesdeRecorte += 1
            if (anotadosDesdeRecorte >= 100) {
                anotadosDesdeRecorte = 0
                recortar(contexto)
            }
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
