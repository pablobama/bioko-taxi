package gq.taxi.conductor

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager

// Lectura de posición única: la última conocida por el sistema, sin encender
// el chip ni esperar. Sin permiso o sin posición devuelve null y todo sigue
// funcionando en manual.
object Ubicacion {
    fun actual(contexto: Context): Location? {
        if (contexto.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }
        val gestor = contexto.getSystemService(LocationManager::class.java)
        return try {
            gestor.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: gestor.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
            null
        }
    }
}
