plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// FCM necesita el google-services.json del proyecto Firebase (consola de
// Firebase → añadir app Android con el paquete gq.taxi.conductor). El plugin
// solo se aplica si el fichero existe, para poder COMPILAR sin él; sin ese
// fichero la app arranca pero el registro FCM fallará ruidosamente.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.warn("AVISO: falta app/google-services.json — el APK compilará pero FCM no funcionará.")
}

android {
    namespace = "gq.taxi.conductor"
    compileSdk = 34

    defaultConfig {
        applicationId = "gq.taxi.conductor"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // Objetivo < 6 MB: R8 activado.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Firma: usar SIEMPRE la misma clave desde el primer APK repartido
            // (decisión de distribución: APK directo ahora, Play Store después,
            // misma firma para no romper actualizaciones).
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Única dependencia externa: FCM. Sin AppCompat, sin corrutinas, sin
    // librerías de red: Activity plana, HttpURLConnection y org.json.
    implementation("com.google.firebase:firebase-messaging:24.0.1")
}
