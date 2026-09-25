package gq.taxi.conductor

import android.content.Context
import java.util.UUID

// Estado persistente mínimo: uuid del dispositivo (la identidad, regla 4.2.4),
// dirección del servidor y teléfono registrado. Todo lo demás vive en el
// servidor y se consulta.
object Sesion {
    private const val PREFERENCIAS = "sesion"

    private fun prefs(contexto: Context) =
        contexto.getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE)

    fun uuidDispositivo(contexto: Context): String {
        val p = prefs(contexto)
        var uuid = p.getString("uuid", null)
        if (uuid == null) {
            uuid = UUID.randomUUID().toString()
            p.edit().putString("uuid", uuid).apply()
        }
        return uuid
    }

    fun urlBase(contexto: Context): String? = prefs(contexto).getString("urlBase", null)

    // El secreto de sesión (migración 069, P15-04). El uuid dice quién dices
    // ser; esto es lo que lo demuestra. Se pide una vez al servidor y se
    // guarda aquí: si se borran los datos de la aplicación se pierden los dos
    // y el teléfono vuelve como dispositivo nuevo, que es lo correcto.
    fun secreto(contexto: Context): String? = prefs(contexto).getString("secreto", null)

    fun guardarSecreto(contexto: Context, secreto: String) {
        prefs(contexto).edit().putString("secreto", secreto).apply()
    }

    fun telefono(contexto: Context): String? = prefs(contexto).getString("telefono", null)

    fun zonaId(contexto: Context): Long = prefs(contexto).getLong("zonaId", -1L)

    fun guardarRegistro(contexto: Context, urlBase: String, telefono: String) {
        prefs(contexto).edit()
            .putString("urlBase", urlBase.trimEnd('/'))
            .putString("telefono", telefono)
            .apply()
    }

    fun guardarZona(contexto: Context, zonaId: Long) {
        prefs(contexto).edit().putLong("zonaId", zonaId).apply()
    }

    fun registrado(contexto: Context): Boolean =
        urlBase(contexto) != null && telefono(contexto) != null
}
