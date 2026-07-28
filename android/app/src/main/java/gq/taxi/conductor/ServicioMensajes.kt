package gq.taxi.conductor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.Executors

// Receptor FCM (decisión 3.3): los mensajes de datos con prioridad alta
// llegan aunque el teléfono esté en Doze con la pantalla apagada. El mensaje
// es solo un despertador: el estado de verdad se pide siempre a la API.
class ServicioMensajes : FirebaseMessagingService() {

    companion object {
        const val ACCION_ACTUALIZAR = "gq.taxi.conductor.ACTUALIZAR"
        const val CANAL_OFERTAS = "ofertas"
    }

    private val ejecutor = Executors.newSingleThreadExecutor()

    override fun onMessageReceived(mensaje: RemoteMessage) {
        val tipo = mensaje.data["tipo"] ?: return

        // Si la actividad está abierta, este broadcast la refresca.
        sendBroadcast(Intent(ACCION_ACTUALIZAR).setPackage(packageName))

        // Si no lo está, la oferta se anuncia con notificación sonora.
        if (tipo == "D1_broadcast_solicitud") {
            notificarOferta()
        }
    }

    private fun notificarOferta() {
        val gestor = getSystemService(NotificationManager::class.java)
        val abrir = PendingIntent.getActivity(
            this, 0,
            Intent(this, ActividadPrincipal::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val constructor = if (Build.VERSION.SDK_INT >= 26) {
            gestor.createNotificationChannel(
                NotificationChannel(
                    CANAL_OFERTAS,
                    getString(R.string.canal_ofertas),
                    NotificationManager.IMPORTANCE_HIGH,
                ),
            )
            Notification.Builder(this, CANAL_OFERTAS)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH)
        }
        val notificacion = constructor
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle(getString(R.string.titulo_oferta))
            .setContentText("Abre para ver origen, destino y precio orientativo")
            .setAutoCancel(true)
            .setContentIntent(abrir)
            .build()
        gestor.notify(1, notificacion)
    }

    // Token nuevo (reinstalación, rotación de Google): re-registro inmediato.
    override fun onNewToken(token: String) {
        if (!Sesion.registrado(this)) return
        ejecutor.execute {
            try {
                Api.registrar(this, Sesion.telefono(this)!!, token)
            } catch (_: Exception) {
                // Sin red ahora: el siguiente registro al abrir la app lo enviará.
            }
        }
    }
}
