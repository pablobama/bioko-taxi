package gq.taxi.conductor

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper

// La posición del coche.
//
// Había solo lectura puntual: `getLastKnownLocation`, la última que el sistema
// tuviera guardada. Eso NO enciende el chip, y ahí estaba el problema del
// recorrido: con la pantalla bloqueada y ninguna otra aplicación pidiendo GPS,
// la última posición conocida se queda quieta. El servicio en primer plano
// latía cada treinta segundos mandando, una y otra vez, el mismo punto viejo.
//
// Ahora, mientras el taxista está en servicio, se piden actualizaciones DE
// VERDAD. Es lo que hace que el recorrido se grabe con el móvil en el bolsillo,
// que es justo lo que una PWA no puede hacer: al bloquear la pantalla el
// navegador congela el JavaScript y no hay nada que leer. Aquí no, porque el
// servicio en primer plano mantiene el proceso vivo y Android le concede el
// GPS mientras dure la notificación.
//
// No hace falta ACCESS_BACKGROUND_LOCATION: el servicio se arranca con la
// aplicación delante y declara `foregroundServiceType="location"`, y a eso
// Android le da ubicación con el permiso normal. Pedir el de segundo plano
// obligaría al taxista a un segundo diálogo y a ir a los ajustes del sistema
// a marcar «permitir siempre», y no da nada a cambio.
object Ubicacion {

    // Cada cuánto y cada cuántos metros se le pide al sistema una posición
    // nueva. Más fino no serviría: el recorrido se guarda como mucho cada 45 s
    // (ver ColaRastro), así que pedir más solo gastaría batería.
    private const val INTERVALO_MS = 20_000L
    private const val DESPLAZAMIENTO_M = 20f

    // Pasada de esta edad, una posición deja de valer como «dónde está ahora».
    private const val FRESCURA_MS = 90_000L

    private var ultima: Location? = null
    private var oyente: LocationListener? = null

    private fun hayPermiso(contexto: Context) =
        contexto.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // La posición de ahora. Primero la del seguimiento, si está fresca; si no,
    // la última que sepa el sistema. Sin permiso o sin ninguna, null: todo
    // sigue funcionando en manual.
    fun actual(contexto: Context): Location? {
        val seguida = ultima
        if (seguida != null && System.currentTimeMillis() - seguida.time < FRESCURA_MS) {
            return seguida
        }
        if (!hayPermiso(contexto)) return null
        val gestor = contexto.getSystemService(LocationManager::class.java)
        return try {
            gestor.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: gestor.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                ?: seguida
        } catch (_: Exception) {
            seguida
        }
    }

    // Empieza a pedir posiciones. `alRecibir` se llama con cada una, en el hilo
    // principal; quien la use para hablar con la red que lo haga en su
    // ejecutor. Llamarla dos veces no duplica nada.
    @Synchronized
    fun empezarSeguimiento(contexto: Context, alRecibir: (Location) -> Unit) {
        if (oyente != null) return
        if (!hayPermiso(contexto)) return
        val gestor = contexto.getSystemService(LocationManager::class.java)
        val nuevo = LocationListener { posicion ->
            ultima = posicion
            alRecibir(posicion)
        }
        try {
            // Los dos proveedores a la vez: el GPS es el bueno, pero dentro de
            // un edificio o en el primer minuto puede no dar nada, y ahí la red
            // da algo. Se pide a los dos y manda el que llegue.
            gestor.requestLocationUpdates(
                LocationManager.GPS_PROVIDER, INTERVALO_MS, DESPLAZAMIENTO_M,
                nuevo, Looper.getMainLooper(),
            )
            try {
                gestor.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, INTERVALO_MS, DESPLAZAMIENTO_M,
                    nuevo, Looper.getMainLooper(),
                )
            } catch (_: Exception) {
                // Hay móviles sin proveedor de red. Con el GPS basta.
            }
            oyente = nuevo
        } catch (_: Exception) {
            // Sin GPS disponible: se queda como estaba, leyendo la última
            // conocida. Peor, pero no roto.
        }
    }

    @Synchronized
    fun pararSeguimiento(contexto: Context) {
        val actual = oyente ?: return
        oyente = null
        try {
            contexto.getSystemService(LocationManager::class.java)
                .removeUpdates(actual)
        } catch (_: Exception) {
            // Nada que hacer: el proceso se está yendo de todos modos.
        }
    }
}
