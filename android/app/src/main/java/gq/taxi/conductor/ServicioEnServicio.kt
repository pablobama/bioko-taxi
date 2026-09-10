package gq.taxi.conductor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.util.concurrent.Executors

// Foreground service (decisión 3.3): mientras el conductor está en servicio,
// una notificación persistente mantiene el proceso vivo y un heartbeat cada
// 30 s renueva la presencia.
//
// Y desde la migración 051 hace lo que ninguna PWA puede hacer: GRABAR EL
// RECORRIDO CON LA PANTALLA BLOQUEADA. El navegador congela el JavaScript al
// bloquear el teléfono y no queda nada que lea el GPS; aquí el proceso sigue
// vivo mientras dure la notificación y Android le concede la ubicación.
//
// El recorrido se apunta en el móvil, no se manda punto a punto: sin red se
// guarda igual y sube en cuanto vuelve. La señal de que hay red es un latido
// que ha salido bien — la más barata y la más fiable.
class ServicioEnServicio : Service() {

    companion object {
        const val CANAL_SERVICIO = "servicio"
        // 30 s: renueva presencia (ventana de 120 s) y, durante el viaje,
        // alimenta el GPS continuo de la detección por proximidad.
        private const val INTERVALO_HEARTBEAT_MS = 30_000L
        // Vueltas de subida por latido. Cinco lotes de cien son quinientos
        // puntos: seis horas de apagón de cobertura recuperadas en un latido.
        private const val VUELTAS_SUBIDA = 5
    }

    private val ejecutor = Executors.newSingleThreadExecutor()
    private val temporizador = Handler(Looper.getMainLooper())

    private val latido = object : Runnable {
        override fun run() {
            ejecutor.execute {
                try {
                    val posicion = Ubicacion.actual(this@ServicioEnServicio)
                    Api.heartbeat(this@ServicioEnServicio, posicion?.latitude, posicion?.longitude)
                    // El latido ha salido: hay red. Es el momento de vaciar lo
                    // que se apuntó mientras no la había.
                    subirRecorridoPendiente()
                } catch (_: Exception) {
                    // Sin red: el siguiente latido lo reintenta, y el recorrido
                    // se sigue apuntando en el móvil mientras tanto. Si pasan
                    // doce horas sin ninguno, el servidor da el turno por
                    // abandonado (migración 049).
                }
            }
            temporizador.postDelayed(this, INTERVALO_HEARTBEAT_MS)
        }
    }

    // Cada lote se borra SOLO cuando el servidor confirma haberlo recibido. Si
    // la respuesta se pierde por el camino, el lote se reenvía y allí se
    // descarta por repetido: para eso está el índice único de la 051.
    private fun subirRecorridoPendiente() {
        for (vuelta in 0 until VUELTAS_SUBIDA) {
            val pendientes = ColaRastro.pendientes(this)
            if (pendientes.isEmpty()) return
            Api.subirRastro(this, pendientes)
            ColaRastro.olvidar(this, pendientes.size)
            if (pendientes.size < ColaRastro.LOTE) return
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val gestor = getSystemService(NotificationManager::class.java)
        val constructor = if (Build.VERSION.SDK_INT >= 26) {
            gestor.createNotificationChannel(
                NotificationChannel(
                    CANAL_SERVICIO,
                    getString(R.string.canal_servicio),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            Notification.Builder(this, CANAL_SERVICIO)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val abrir = PendingIntent.getActivity(
            this, 0,
            Intent(this, ActividadPrincipal::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notificacion = constructor
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.notificacion_en_servicio))
            .setContentText(getString(R.string.notificacion_en_servicio_detalle))
            .setStyle(
                Notification.BigTextStyle()
                    .bigText(getString(R.string.notificacion_en_servicio_detalle)),
            )
            .setOngoing(true)
            .setContentIntent(abrir)
            .build()
        startForeground(2, notificacion)

        // El GPS de verdad, no la última posición conocida. Sin esto, con la
        // pantalla bloqueada el sistema no vuelve a fijar la posición y el
        // latido manda el mismo punto viejo una y otra vez: un recorrido de un
        // solo punto y un coche clavado en el mapa del pasajero.
        ColaRastro.olvidarUltimo()
        Ubicacion.empezarSeguimiento(this) { posicion ->
            // Solo apuntar, que es barato y no toca la red. Subir es cosa del
            // latido, cuando se sepa que hay cobertura.
            ejecutor.execute { ColaRastro.anotar(this, posicion) }
        }

        temporizador.removeCallbacks(latido)
        temporizador.post(latido)
        return START_STICKY
    }

    override fun onDestroy() {
        temporizador.removeCallbacks(latido)
        // Soltar el GPS al salir de servicio es la mitad de la promesa: fuera
        // del turno no se registra por dónde anda, y tener el chip encendido
        // sin necesidad es batería de alguien que trabaja con el móvil.
        Ubicacion.pararSeguimiento(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
