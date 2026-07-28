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
// 60 s renueva la presencia (la ventana del servidor es de 120 s: hay margen
// para perder uno).
class ServicioEnServicio : Service() {

    companion object {
        const val CANAL_SERVICIO = "servicio"
        // 30 s: renueva presencia (ventana de 120 s) y, durante el viaje,
        // alimenta el GPS continuo de la detección por proximidad.
        private const val INTERVALO_HEARTBEAT_MS = 30_000L
    }

    private val ejecutor = Executors.newSingleThreadExecutor()
    private val temporizador = Handler(Looper.getMainLooper())

    private val latido = object : Runnable {
        override fun run() {
            ejecutor.execute {
                try {
                    val posicion = Ubicacion.actual(this@ServicioEnServicio)
                    Api.heartbeat(this@ServicioEnServicio, posicion?.latitude, posicion?.longitude)
                } catch (_: Exception) {
                    // Sin red: el siguiente latido lo reintenta. Si pasan más
                    // de 120 s, el servidor nos da por desconectados — que es
                    // exactamente lo que somos.
                }
            }
            temporizador.postDelayed(this, INTERVALO_HEARTBEAT_MS)
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
            .setOngoing(true)
            .setContentIntent(abrir)
            .build()
        startForeground(2, notificacion)

        temporizador.removeCallbacks(latido)
        temporizador.post(latido)
        return START_STICKY
    }

    override fun onDestroy() {
        temporizador.removeCallbacks(latido)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
