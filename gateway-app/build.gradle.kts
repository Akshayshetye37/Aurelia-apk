plugins {
    id("com.android.application") version "8.9.1"
}

android {
    namespace = "com.aurelia.paybridge"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aurelia.paybridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
